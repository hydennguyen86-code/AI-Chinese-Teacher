// A small, dependency-free WebGL 3D teacher. Mouth motion follows speech time,
// not phonemes; a future VRM model can replace this module without changing chat.
class TeacherAvatar {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext('webgl', {antialias: true, alpha: true});
    this.talking = false;
    if (!this.gl) return;
    const gl = this.gl;
    const vertex = `
      attribute vec3 aPosition;
      attribute vec3 aNormal;
      attribute vec2 aUV;
      uniform vec3 uScale;
      uniform vec3 uOffset;
      uniform float uYaw;
      varying vec3 vNormal;
      varying vec2 vUV;
      void main() {
        float c = cos(uYaw), s = sin(uYaw);
        vec3 p = aPosition * uScale + uOffset;
        p = vec3(c*p.x + s*p.z, p.y, -s*p.x + c*p.z);
        vec3 n = normalize(aNormal / uScale);
        vNormal = normalize(vec3(c*n.x + s*n.z, n.y, -s*n.x + c*n.z));
        vUV = aUV;
        gl_Position = vec4(p.x / 1.55, p.y / 1.9, -p.z / 5.0, 1.0);
      }`;
    const fragment = `
      precision mediump float;
      uniform vec3 uColor;
      uniform float uHasTexture;
      uniform sampler2D uFaceTexture;
      uniform vec4 uFaceCrop;
      varying vec3 vNormal;
      varying vec2 vUV;
      void main() {
        vec3 light = normalize(vec3(-0.42, 0.8, 1.0));
        float shade = 0.56 + 0.44 * max(0.0, dot(normalize(vNormal), light));
        if (uHasTexture > 0.5) {
          if (distance(vUV, vec2(0.5, 0.5)) > 0.49) discard;
          vec2 uv = uFaceCrop.xy + vUV * uFaceCrop.zw;
          vec3 photo = texture2D(uFaceTexture, uv).rgb;
          gl_FragColor = vec4(photo * shade, 1.0);
          return;
        }
        gl_FragColor = vec4(uColor * shade, 1.0);
      }`;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    };
    const program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
      throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);
    this.program = program;
    this.attributes = {position: gl.getAttribLocation(program, 'aPosition'),
      normal: gl.getAttribLocation(program, 'aNormal')};
    this.uniforms = {scale: gl.getUniformLocation(program, 'uScale'),
      offset: gl.getUniformLocation(program, 'uOffset'),
      yaw: gl.getUniformLocation(program, 'uYaw'),
      color: gl.getUniformLocation(program, 'uColor'),
      hasTexture: gl.getUniformLocation(program, 'uHasTexture'),
      faceTexture: gl.getUniformLocation(program, 'uFaceTexture'),
      faceCrop: gl.getUniformLocation(program, 'uFaceCrop')};
    this.faceTexture = gl.createTexture();
    this.faceReady = false;
    const face = new Image();
    face.onload = () => {
      gl.bindTexture(gl.TEXTURE_2D, this.faceTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, face);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      this.faceReady = true;
    };
    face.src = './assets/mom_avatar.jpg';
    this.mesh = this.makeSphere();
    this.photoMesh = this.makePhotoFace();
    gl.enable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    requestAnimationFrame((time) => this.frame(time));
  }

  makeSphere() {
    const positions = [], normals = [], uvs = [], indices = [];
    const rings = 20, slices = 28;
    for (let y = 0; y <= rings; y++) {
      const theta = Math.PI * y / rings;
      for (let x = 0; x <= slices; x++) {
        const phi = 2 * Math.PI * x / slices;
        const n = [Math.sin(theta) * Math.cos(phi), Math.cos(theta),
                   Math.sin(theta) * Math.sin(phi)];
        positions.push(...n); normals.push(...n);
        // Map the camera-facing hemisphere (phi 0..PI) to the photo.
        uvs.push(1 - phi / Math.PI, 1 - theta / Math.PI);
      }
    }
    for (let y = 0; y < rings; y++) for (let x = 0; x < slices; x++) {
      const a = y * (slices + 1) + x, b = a + slices + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
    const gl = this.gl;
    const buffer = (target, values) => {
      const result = gl.createBuffer(); gl.bindBuffer(target, result);
      gl.bufferData(target, values, gl.STATIC_DRAW); return result;
    };
    return {positions: buffer(gl.ARRAY_BUFFER, new Float32Array(positions)),
      normals: buffer(gl.ARRAY_BUFFER, new Float32Array(normals)),
      uvs: buffer(gl.ARRAY_BUFFER, new Float32Array(uvs)),
      indices: buffer(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices)), count: indices.length};
  }

  makePhotoFace() {
    const positions = [], normals = [], uvs = [], indices = [];
    const divisions = 48;
    for (let y = 0; y <= divisions; y++) {
      const v = y / divisions, ny = 1 - 2 * v;
      for (let x = 0; x <= divisions; x++) {
        const u = x / divisions, nx = 2 * u - 1;
        positions.push(nx, ny, 0.12 * Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)));
        normals.push(0, 0, 1);
        uvs.push(u, v);
      }
    }
    for (let y = 0; y < divisions; y++) for (let x = 0; x < divisions; x++) {
      const cx = 2 * (x + 0.5) / divisions - 1;
      const cy = 1 - 2 * (y + 0.5) / divisions;
      if (cx * cx + cy * cy > 0.98) continue;
      const a = y * (divisions + 1) + x, b = a + divisions + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
    const gl = this.gl;
    const buffer = (target, values) => {
      const result = gl.createBuffer(); gl.bindBuffer(target, result);
      gl.bufferData(target, values, gl.STATIC_DRAW); return result;
    };
    return {positions: buffer(gl.ARRAY_BUFFER, new Float32Array(positions)),
      normals: buffer(gl.ARRAY_BUFFER, new Float32Array(normals)),
      uvs: buffer(gl.ARRAY_BUFFER, new Float32Array(uvs)),
      indices: buffer(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(indices)), count: indices.length};
  }

  sphere(offset, scale, color, yaw, useFace = false, meshOverride = null) {
    const gl = this.gl;
    const {attributes, uniforms} = this;
    const mesh = meshOverride || this.mesh;
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.positions);
    gl.enableVertexAttribArray(attributes.position);
    gl.vertexAttribPointer(attributes.position, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.normals);
    gl.enableVertexAttribArray(attributes.normal);
    gl.vertexAttribPointer(attributes.normal, 3, gl.FLOAT, false, 0, 0);
    const uvLocation = gl.getAttribLocation(this.program, 'aUV');
    gl.bindBuffer(gl.ARRAY_BUFFER, mesh.uvs);
    gl.enableVertexAttribArray(uvLocation);
    gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, mesh.indices);
    gl.uniform3fv(uniforms.offset, offset);
    gl.uniform3fv(uniforms.scale, scale);
    gl.uniform3fv(uniforms.color, color);
    gl.uniform1f(uniforms.yaw, yaw);
    gl.uniform1f(uniforms.hasTexture, useFace && this.faceReady ? 1 : 0);
    gl.uniform4f(uniforms.faceCrop, 0.29, 0.32, 0.35, 0.24);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.faceTexture);
    gl.uniform1i(uniforms.faceTexture, 0);
    gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
  }

  setTalking(value) { this.talking = !!value; }

  frame(time) {
    const gl = this.gl;
    if (!gl) return;
    const width = this.canvas.clientWidth * Math.min(devicePixelRatio || 1, 2);
    const height = this.canvas.clientHeight * Math.min(devicePixelRatio || 1, 2);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height;
    }
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const yaw = Math.sin(time / 2400) * 0.045;
    const blink = Math.sin(time / 2100) > 0.995 ? 0.012 : 0.095;
    const mouth = this.talking ? 0.045 + Math.abs(Math.sin(time / 115)) * 0.075 : 0.016;
    const skin = [0.94, 0.66, 0.52], coat = [0.89, 0.91, 0.91];
    // Body, neck, ears, hair, face, and features are actual shaded 3D meshes.
    this.sphere([0, -1.55, -0.22], [0.95, 0.58, 0.45], coat, yaw);
    // The photo provides the hairline, ears, and facial features on the front.
    this.sphere([0, -0.16, 0.12], [0.68, 0.88, 0.59], skin, yaw);
    this.sphere([0, -0.16, 0.68], [0.65, 0.84, 1], skin, yaw, true, this.photoMesh);
    // Eyes, nose, and mouth are part of the photographic face texture.
    requestAnimationFrame((next) => this.frame(next));
  }
}

window.TeacherAvatar = TeacherAvatar;
