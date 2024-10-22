import { GUI } from 'dat.gui';

import showMultisampleTextureWGSL from './showMultisampleTexture.wgsl';
import renderWithAlphaToCoverageWGSL from './renderWithAlphaToCoverage.wgsl';
import renderWithEmulatedAlphaToCoverageWGSL from './renderWithEmulatedAlphaToCoverage.wgsl';
import { quitIfWebGPUNotAvailable } from '../util';
import { kEmulatedAlphaToCoverage } from './emulatedAlphaToCoverage';

const canvas = document.querySelector('canvas') as HTMLCanvasElement;
const adapter = await navigator.gpu?.requestAdapter();
const device = await adapter?.requestDevice();
quitIfWebGPUNotAvailable(adapter, device);

//
// GUI controls
//

const kInitConfig = {
  scene: 'solid_colors',
  emulatedDevice: 'none',
  sizeLog2: 3,
  showResolvedColor: true,
  color1: 0x0000ff,
  alpha1: 127,
  color2: 0xff0000,
  alpha2: 16,
  pause: false,
};
const config = { ...kInitConfig };

const gui = new GUI();
gui.width = 300;
{
  const buttons = {
    initial() {
      Object.assign(config, kInitConfig);
      gui.updateDisplay();
    },
  };

  gui.add(config, 'scene', ['solid_colors']);
  gui.add(config, 'emulatedDevice', [
    'none',
    ...Object.keys(kEmulatedAlphaToCoverage),
  ]);

  const settings = gui.addFolder('Settings');
  settings.open();
  settings.add(config, 'sizeLog2', 0, 8, 1).name('size = 2**');
  settings.add(config, 'showResolvedColor', true);

  const draw1Panel = gui.addFolder('solid_colors Draw 1');
  draw1Panel.open();
  draw1Panel.addColor(config, 'color1').name('color');
  draw1Panel.add(config, 'alpha1', 0, 255).name('alpha');

  const draw2Panel = gui.addFolder('solid_colors Draw 2');
  draw2Panel.open();
  draw2Panel.addColor(config, 'color2').name('color');
  draw2Panel.add(config, 'alpha2', 0, 255).name('alpha');
  draw2Panel.add(config, 'pause', false);

  gui.add(buttons, 'initial').name('reset to initial');
}

//
// Canvas setup
//

function updateCanvasSize() {
  const devicePixelRatio = window.devicePixelRatio;
  canvas.width = canvas.clientWidth * devicePixelRatio;
  canvas.height = canvas.clientHeight * devicePixelRatio;
}
updateCanvasSize();
const presentationFormat = navigator.gpu.getPreferredCanvasFormat();

const context = canvas.getContext('webgpu') as GPUCanvasContext;
context.configure({
  device,
  format: presentationFormat,
});

//
// GPU state controlled by the config gui
//

const bufInstanceColors = device.createBuffer({
  usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.VERTEX,
  size: 8,
});

let actualMSTexture: GPUTexture, actualMSTextureView: GPUTextureView;
let emulatedMSTexture: GPUTexture, emulatedMSTextureView: GPUTextureView;
let resolveTexture: GPUTexture, resolveTextureView: GPUTextureView;
let lastSize = 0;
let renderWithEmulatedAlphaToCoveragePipeline: GPURenderPipeline | null;
let lastEmulatedDevice = 'none';
function resetConfiguredObjects() {
  const size = 2 ** config.sizeLog2;
  if (lastSize !== size) {
    if (actualMSTexture) {
      actualMSTexture.destroy();
    }
    if (emulatedMSTexture) {
      emulatedMSTexture.destroy();
    }
    const msTextureDesc = {
      format: 'rgba8unorm' as const,
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      size: [size, size],
      sampleCount: 4,
    };
    actualMSTexture = device.createTexture(msTextureDesc);
    actualMSTextureView = actualMSTexture.createView();
    emulatedMSTexture = device.createTexture(msTextureDesc);
    emulatedMSTextureView = emulatedMSTexture.createView();

    if (resolveTexture) {
      resolveTexture.destroy();
    }
    resolveTexture = device.createTexture({
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      size: [size, size],
    });
    resolveTextureView = resolveTexture.createView();

    lastSize = size;
  }

  if (
    config.emulatedDevice !== 'none' &&
    lastEmulatedDevice !== config.emulatedDevice
  ) {
    // Pipeline to render to a multisampled texture using *emulated* alpha-to-coverage
    const renderWithEmulatedAlphaToCoverageModule = device.createShaderModule({
      code:
        renderWithEmulatedAlphaToCoverageWGSL +
        kEmulatedAlphaToCoverage[config.emulatedDevice],
    });
    renderWithEmulatedAlphaToCoveragePipeline = device.createRenderPipeline({
      label: 'renderWithEmulatedAlphaToCoveragePipeline',
      layout: 'auto',
      vertex: {
        module: renderWithEmulatedAlphaToCoverageModule,
        buffers: [
          {
            stepMode: 'instance',
            arrayStride: 4,
            attributes: [{ shaderLocation: 0, format: 'unorm8x4', offset: 0 }],
          },
        ],
      },
      fragment: {
        module: renderWithEmulatedAlphaToCoverageModule,
        targets: [{ format: 'rgba8unorm' }],
      },
      multisample: { count: 4, alphaToCoverageEnabled: false },
      primitive: { topology: 'triangle-list' },
    });
  } else {
    renderWithEmulatedAlphaToCoveragePipeline = null;
  }
}

function applyConfig() {
  // Update the colors in the (instance-step-mode) vertex buffer
  const data = new Uint8Array([
    // instance 0 color
    (config.color1 >> 16) & 0xff, // R
    (config.color1 >> 8) & 0xff, // G
    (config.color1 >> 0) & 0xff, // B
    config.alpha1,
    // instance 1 color
    (config.color2 >> 16) & 0xff, // R
    (config.color2 >> 8) & 0xff, // G
    (config.color2 >> 0) & 0xff, // B
    config.alpha2,
  ]);
  device.queue.writeBuffer(bufInstanceColors, 0, data);

  resetConfiguredObjects();
}

//
// Pipeline to render to a multisampled texture using alpha-to-coverage
//

const renderWithAlphaToCoverageModule = device.createShaderModule({
  code: renderWithAlphaToCoverageWGSL,
});
const renderWithAlphaToCoveragePipeline = device.createRenderPipeline({
  label: 'renderWithAlphaToCoveragePipeline',
  layout: 'auto',
  vertex: {
    module: renderWithAlphaToCoverageModule,
    buffers: [
      {
        stepMode: 'instance',
        arrayStride: 4,
        attributes: [{ shaderLocation: 0, format: 'unorm8x4', offset: 0 }],
      },
    ],
  },
  fragment: {
    module: renderWithAlphaToCoverageModule,
    targets: [{ format: 'rgba8unorm' }],
  },
  multisample: { count: 4, alphaToCoverageEnabled: true },
  primitive: { topology: 'triangle-list' },
});

//
// "Debug" view of the actual texture contents
//

const showMultisampleTextureModule = device.createShaderModule({
  code: showMultisampleTextureWGSL,
});
const showMultisampleTexturePipeline = device.createRenderPipeline({
  label: 'showMultisampleTexturePipeline',
  layout: 'auto',
  vertex: {
    module: showMultisampleTextureModule,
    buffers: [
      {
        stepMode: 'instance',
        arrayStride: 4,
        attributes: [{ shaderLocation: 0, format: 'unorm8x4', offset: 0 }],
      },
    ],
  },
  fragment: {
    module: showMultisampleTextureModule,
    targets: [{ format: presentationFormat }],
  },
  primitive: { topology: 'triangle-list' },
});
const showMultisampleTextureBGL =
  showMultisampleTexturePipeline.getBindGroupLayout(0);

function render() {
  applyConfig();

  const showMultisampleTextureBG = device.createBindGroup({
    layout: showMultisampleTextureBGL,
    entries: [
      { binding: 0, resource: actualMSTextureView },
      {
        binding: 1,
        resource:
          config.emulatedDevice === 'none'
            ? actualMSTextureView
            : emulatedMSTextureView,
      },
      { binding: 2, resource: resolveTextureView },
    ],
  });

  const commandEncoder = device.createCommandEncoder();
  // clear resolveTextureView to gray if it won't be used
  if (!config.showResolvedColor) {
    const pass = commandEncoder.beginRenderPass({
      colorAttachments: [
        {
          view: resolveTextureView,
          clearValue: [0.3, 0.3, 0.3, 1],
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.end();
  }
  // renderWithAlphaToCoverage pass
  {
    const pass = commandEncoder.beginRenderPass({
      label: 'renderWithAlphaToCoverage pass',
      colorAttachments: [
        {
          view: actualMSTextureView,
          resolveTarget: config.showResolvedColor
            ? resolveTextureView
            : undefined,
          clearValue: [0, 0, 0, 1], // black background
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(renderWithAlphaToCoveragePipeline);
    pass.setVertexBuffer(0, bufInstanceColors);
    pass.draw(6, 2);
    pass.end();
  }
  // renderWithEmulatedAlphaToCoverage pass
  if (renderWithEmulatedAlphaToCoveragePipeline) {
    const pass = commandEncoder.beginRenderPass({
      label: 'renderWithEmulatedAlphaToCoverage pass',
      colorAttachments: [
        {
          view: emulatedMSTextureView,
          clearValue: [0, 0, 0, 1], // black background
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(renderWithEmulatedAlphaToCoveragePipeline);
    pass.setVertexBuffer(0, bufInstanceColors);
    pass.draw(6, 2);
    pass.end();
  }
  // showMultisampleTexture pass
  {
    const pass = commandEncoder.beginRenderPass({
      label: 'showMultisampleTexture pass',
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: [1, 0, 1, 1], // error color, will be overwritten
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.setPipeline(showMultisampleTexturePipeline);
    pass.setBindGroup(0, showMultisampleTextureBG);
    pass.setVertexBuffer(0, bufInstanceColors);
    pass.draw(6);
    pass.end();
  }
  device.queue.submit([commandEncoder.finish()]);
}

function frame() {
  if (!config.pause) {
    // scrub alpha2 over 15 seconds
    let alpha = ((performance.now() / 15000) % 1) * (255 + 20) - 10;
    alpha = Math.max(0, Math.min(alpha, 255));
    config.alpha2 = alpha;
    gui.updateDisplay();
  }
  updateCanvasSize();
  render();
  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
