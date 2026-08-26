// Correct OKLCH → Hex conversion using OKLab color space

function oklchToHex(L, C, H) {
  // OKLCH → OKLab
  const a = C * Math.cos(H * Math.PI / 180);
  const b = C * Math.sin(H * Math.PI / 180);

  // OKLab → LMS
  const l = L + 0.3963377774 * a + 0.2158037573 * b;
  const m = L - 0.1055613458 * a - 0.0638541728 * b;
  const s = L - 0.0894841775 * a - 1.2914855480 * b;

  // Cube LMS
  const l3 = l * l * l;
  const m3 = m * m * m;
  const s3 = s * s * s;

  // LMS → linear sRGB
  let R = +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3;
  let G = -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3;
  let B = -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3;

  // linear sRGB → sRGB
  const toSrgb = (c) => c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1/2.4) - 0.055;
  R = toSrgb(R);
  G = toSrgb(G);
  B = toSrgb(B);

  const clamp = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255);
  return '#' + [R, G, B].map(v => clamp(v).toString(16).padStart(2, '0')).join('');
}

console.log('Light primary (teal oklch 0.55 0.18 175):', oklchToHex(0.55, 0.18, 175));
console.log('Dark background (navy oklch 0.129 0.042 264.695):', oklchToHex(0.129, 0.042, 264.695));
console.log('Dark primary (oklch 0.929 0.013 255.508):', oklchToHex(0.929, 0.013, 255.508));
