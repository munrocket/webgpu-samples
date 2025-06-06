import { GUI } from 'dat.gui';
import Scene from './scene';
import Common from './common';
import Radiosity from './radiosity';
import Rasterizer from './rasterizer';
import Tonemapper from './tonemapper';
import Raytracer from './raytracer';
import {
  quitIfAdapterNotAvailable,
  quitIfWebGPUNotAvailable,
  quitIfLimitLessThan,
} from '../util';

const canvas = document.querySelector('canvas') as HTMLCanvasElement;

const adapter = await navigator.gpu?.requestAdapter({
  featureLevel: 'compatibility',
});
quitIfAdapterNotAvailable(adapter);

const features: GPUFeatureName[] = [];
let presentationFormat = navigator.gpu.getPreferredCanvasFormat();
if (presentationFormat == 'bgra8unorm') {
  if (adapter.features.has('bgra8unorm-storage')) {
    features.push('bgra8unorm-storage');
  } else {
    // If the GPU prefers BGRA for presentation but the Adapter
    // doesn't support bgra8unorm-storage (e.g., Compatibility
    // mode), use rgba8unorm for both. This will be slower, but will
    // work.
    presentationFormat = 'rgba8unorm';
  }
}
const limits: Record<string, GPUSize32> = {};
quitIfLimitLessThan(adapter, 'maxComputeWorkgroupSizeX', 256, limits);
quitIfLimitLessThan(adapter, 'maxComputeInvocationsPerWorkgroup', 256, limits);
const device = await adapter?.requestDevice({
  requiredFeatures: features,
  requiredLimits: limits,
});
quitIfWebGPUNotAvailable(adapter, device);

const params: {
  renderer: 'rasterizer' | 'raytracer';
  rotateCamera: boolean;
} = {
  renderer: 'rasterizer',
  rotateCamera: true,
};

const gui = new GUI();
gui.add(params, 'renderer', ['rasterizer', 'raytracer']);
gui.add(params, 'rotateCamera', true);

const devicePixelRatio = window.devicePixelRatio;
canvas.width = canvas.clientWidth * devicePixelRatio;
canvas.height = canvas.clientHeight * devicePixelRatio;

const context = canvas.getContext('webgpu') as GPUCanvasContext;
context.configure({
  device,
  format: presentationFormat,
  usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.STORAGE_BINDING,
});

const framebuffer = device.createTexture({
  label: 'framebuffer',
  size: [canvas.width, canvas.height],
  format: 'rgba16float',
  usage:
    GPUTextureUsage.RENDER_ATTACHMENT |
    GPUTextureUsage.STORAGE_BINDING |
    GPUTextureUsage.TEXTURE_BINDING,
});

const scene = new Scene(device);
const common = new Common(device, scene.quadBuffer);
const radiosity = new Radiosity(device, common, scene);
const rasterizer = new Rasterizer(
  device,
  common,
  scene,
  radiosity,
  framebuffer
);
const raytracer = new Raytracer(device, common, radiosity, framebuffer);

function frame() {
  const canvasTexture = context.getCurrentTexture();
  const commandEncoder = device.createCommandEncoder();

  common.update({
    rotateCamera: params.rotateCamera,
    aspect: canvas.width / canvas.height,
  });
  radiosity.run(commandEncoder);

  switch (params.renderer) {
    case 'rasterizer': {
      rasterizer.run(commandEncoder);
      break;
    }
    case 'raytracer': {
      raytracer.run(commandEncoder);
      break;
    }
  }

  const tonemapper = new Tonemapper(device, common, framebuffer, canvasTexture);
  tonemapper.run(commandEncoder);

  device.queue.submit([commandEncoder.finish()]);

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
