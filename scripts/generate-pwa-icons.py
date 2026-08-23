import cairosvg
import os

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'public', 'pwa')
os.makedirs(OUT, exist_ok=True)

BG_DARK = '#0a0a0a'
ACCENT = '#6366f1'
WHITE = '#ffffff'

def svg_content(size):
    cx = cy = size / 2
    r = size * 0.18
    ring_r = size * 0.34
    inner_r = size * 0.26
    font_size = size * 0.42
    dot_r = size * 0.028
    
    dot_positions = []
    for dx, dy in [(cx, cy - ring_r - size*0.02), (cx, cy + ring_r + size*0.02), 
                   (cx - ring_r - size*0.02, cy), (cx + ring_r + size*0.02, cy)]:
        if 0 < dx < size and 0 < dy < size:
            dot_positions.append((dx, dy))
    
    lines = ''
    for dx, dy in dot_positions:
        nx, ny = dx - cx, dy - cy
        norm = (nx**2 + ny**2)**0.5
        if norm > 0:
            ux, uy = nx/norm, ny/norm
            x1, y1 = cx + ux*ring_r, cy + uy*ring_r
            x2, y2 = dx - ux*size*0.06, dy - uy*size*0.06
            lines += f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{ACCENT}" stroke-width="{size*0.012:.1f}" opacity="0.4"/>'
    
    dots = ''
    for dx, dy in dot_positions:
        dots += f'<circle cx="{dx:.1f}" cy="{dy:.1f}" r="{dot_r:.1f}" fill="{ACCENT}" opacity="0.8"/>'
    
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 {size} {size}">
  <rect width="{size}" height="{size}" rx="{r:.1f}" ry="{r:.1f}" fill="{BG_DARK}"/>
  <circle cx="{cx:.1f}" cy="{cy-size*0.02:.1f}" r="{size*0.38:.1f}" fill="{ACCENT}" opacity="0.15"/>
  <circle cx="{cx:.1f}" cy="{cy:.1f}" r="{ring_r:.1f}" fill="none" stroke="{ACCENT}" stroke-width="{size*0.02:.1f}" opacity="0.6"/>
  <circle cx="{cx:.1f}" cy="{cy:.1f}" r="{inner_r:.1f}" fill="none" stroke="{ACCENT}" stroke-width="{size*0.012:.1f}" opacity="0.3"/>
  {lines}
  {dots}
  <text x="{cx:.1f}" y="{cy + font_size*0.35:.1f}" font-family="Arial,Helvetica,sans-serif" font-size="{font_size:.1f}" font-weight="bold" fill="{WHITE}" text-anchor="middle">X</text>
</svg>'''

for s in [192, 512, 48]:
    svg = svg_content(s)
    svg_path = os.path.join(OUT, f'icon-{s}.svg')
    png_path = os.path.join(OUT, f'icon-{s}.png')
    with open(svg_path, 'w') as f:
        f.write(svg)
    cairosvg.svg2png(bytestring=svg.encode(), write_to=png_path, output_width=s, output_height=s)
    print(f'Generated {png_path} ({s}x{s})')

print('Done!')
