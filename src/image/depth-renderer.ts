/**
 * 深度伪彩色: uint16毫米原样传成WebGL2的R16UI纹理, 片元着色器按 [near, far] 归一化 (量程外截到两端) 后用turbo上色, 0 (无效) 画黑.
 * 整数纹理只能NEAREST取样 (深度本就不该插值); near/far走uniform, 改量程不重传数据. 每帧上传+绘制 < 0.4ms (research 03).
 */

const VERTEX_SHADER = `#version 300 es
// 一个盖满画布的三角形, 不用顶点缓冲; 可见部分corner在 [0, 1], 纹理第0行为图像顶行
out vec2 uv;
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  uv = vec2(corner.x, 1.0 - corner.y);
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp usampler2D;
uniform usampler2D depth;
uniform float near;
uniform float far;
in vec2 uv;
out vec4 color;

// turbo色图的多项式近似 (Google, Apache-2.0)
vec3 turbo(float x) {
  const vec4 kRedVec4 = vec4(0.13572138, 4.61539260, -42.66032258, 132.13108234);
  const vec4 kGreenVec4 = vec4(0.09140261, 2.19418839, 4.84296658, -14.18503333);
  const vec4 kBlueVec4 = vec4(0.10667330, 12.64194608, -60.58204836, 110.36276771);
  const vec2 kRedVec2 = vec2(-152.94239396, 59.28637943);
  const vec2 kGreenVec2 = vec2(4.27729857, 2.82956604);
  const vec2 kBlueVec2 = vec2(-89.90310912, 27.34824973);
  x = clamp(x, 0.0, 1.0);
  vec4 v4 = vec4(1.0, x, x * x, x * x * x);
  vec2 v2 = v4.zw * v4.z;
  return vec3(
    dot(v4, kRedVec4) + dot(v2, kRedVec2),
    dot(v4, kGreenVec4) + dot(v2, kGreenVec2),
    dot(v4, kBlueVec4) + dot(v2, kBlueVec2)
  );
}

void main() {
  ivec2 size = textureSize(depth, 0);
  ivec2 texel = min(ivec2(uv * vec2(size)), size - 1);
  uint value = texelFetch(depth, texel, 0).r;
  if (value == 0u) {
    color = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  color = vec4(turbo((float(value) - near) / max(far - near, 1.0)), 1.0);
}`

function compile(gl: WebGL2RenderingContext, type: number, source: string) {
  const shader = gl.createShader(type)!
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? '着色器编译失败')
  return shader
}

export type DepthRenderer = {
  draw: (frame: { width: number; height: number; data: Uint16Array }, near: number, far: number) => void
  dispose: () => void
}

// 在canvas上建深度渲染器; 浏览器没有WebGL2时为null
export function createDepthRenderer(canvas: HTMLCanvasElement): DepthRenderer | null {
  const gl = canvas.getContext('webgl2', { antialias: false, depth: false, preserveDrawingBuffer: false })
  if (!gl) return null
  const program = gl.createProgram()
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER)
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER)
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? '着色器链接失败')
  const nearLocation = gl.getUniformLocation(program, 'near')
  const farLocation = gl.getUniformLocation(program, 'far')
  const vertexArray = gl.createVertexArray()
  let texture: WebGLTexture | null = null
  let textureSize = { width: 0, height: 0 }

  return {
    draw({ width, height, data }, near, far) {
      // 尺寸变了才重建纹理 (texStorage定长), 平时只texSubImage
      if (!texture || textureSize.width !== width || textureSize.height !== height) {
        if (texture) gl.deleteTexture(texture)
        texture = gl.createTexture()
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16UI, width, height)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        textureSize = { width, height }
        canvas.width = width
        canvas.height = height
      }
      gl.bindTexture(gl.TEXTURE_2D, texture)
      // 一行宽度的uint16不一定4字节对齐
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED_INTEGER, gl.UNSIGNED_SHORT, data)
      gl.viewport(0, 0, width, height)
      gl.useProgram(program)
      gl.uniform1f(nearLocation, near)
      gl.uniform1f(farLocation, far)
      gl.bindVertexArray(vertexArray)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    },
    dispose() {
      if (texture) gl.deleteTexture(texture)
      gl.deleteVertexArray(vertexArray)
      gl.deleteProgram(program)
      gl.deleteShader(vertex)
      gl.deleteShader(fragment)
    },
  }
}

// 伪彩色的固定量程 (毫米): 逐帧按自身范围归一化会闪烁; 量程外截到两端
export const DEPTH_NEAR_MILLIMETERS = 200
export const DEPTH_FAR_MILLIMETERS = 2000
