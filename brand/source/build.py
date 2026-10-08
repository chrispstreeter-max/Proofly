"""Renders Proofly's marketing assets (App Store feature image, social banners, posts) from HTML with headless Chrome.

Run from the repository root:  python3 brand/source/build.py
Inputs: brand/source/logo-trim.png and mark-trim.png (cut, unaltered, from the canonical brand/proofly-logo.png).
Rules followed (docs/BRAND.md): logo used as supplied on light backgrounds, gradient once per asset, Inter headlines,
no invented customer claims. Review content in the mock-up is the synthetic demo catalogue data.
"""
import pathlib
import subprocess
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
SRC = ROOT / "brand" / "source"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

STAR = ('<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.6l2.8 6 6.6.7-4.9 4.5 1.4 6.5L12 17l-5.9 3.3 '
        '1.4-6.5-4.9-4.5 6.6-.7z"/></svg>')
STARS = lambda n=5: "".join(f'<i class="s{" off" if i >= n else ""}">{STAR}</i>' for i in range(5))

CARD = f"""
<div class="card">
  <div class="sum">
    <div class="avg">4.8</div>
    <div><div class="stars big">{STARS()}</div><div class="muted">Based on 128 reviews</div></div>
  </div>
  <div class="bars">
    {''.join(f'<div class="bar"><span>{n}</span><b style="--w:{w}%"></b></div>' for n, w in [(5, 84), (4, 12), (3, 3), (2, 1), (1, 0)])}
  </div>
  <div class="rev">
    <div class="who"><span class="av">A</span><b>Alex R.</b><span class="badge">Imported</span></div>
    <div class="stars">{STARS()}</div>
    <p><b>Holds heat well.</b> Keeps coffee warm for ages and feels solid in the hand.</p>
  </div>
</div>"""

BASE_CSS = """
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;800&display=swap');
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: var(--W); height: var(--H); overflow: hidden; }
body { font-family: Inter, -apple-system, system-ui, sans-serif; color: #111221; background: #FBFBFE;
  -webkit-font-smoothing: antialiased; position: relative; }
.glow { position: absolute; border-radius: 50%; background: linear-gradient(135deg, #4047FA 0%, #955BFC 100%);
  filter: blur(var(--blur, 90px)); opacity: .22; }
.logo { display: block; height: var(--logo-h); width: auto; align-self: flex-start; flex: none; }
.mark { display: block; height: var(--mark-h); width: auto; }
h1 { font-weight: 800; letter-spacing: -0.035em; line-height: 1.04; font-size: var(--h1); }
.sub { color: #4a4b5c; font-size: var(--sub); line-height: 1.45; font-weight: 400; max-width: var(--sub-w, 34ch); }
.pill { display: inline-flex; align-items: center; gap: .5em; font-weight: 600; font-size: var(--pill, 18px); color: #2D2DCB;
  background: #EEF0FF; border: 1px solid #DCDFFE; padding: .45em .9em; border-radius: 999px; }
.card { background: #fff; border: 1px solid #E6E7F0; border-radius: 22px; padding: 30px 32px;
  box-shadow: 0 1px 2px rgba(17,18,33,.04), 0 24px 60px -24px rgba(45,45,203,.28); width: 460px; position: relative; }
.sum { display: flex; align-items: center; gap: 18px; }
.avg { font-size: 64px; font-weight: 800; letter-spacing: -0.04em; line-height: 1; }
.stars { display: flex; gap: 3px; }
.s { width: 20px; height: 20px; display: block; }
.stars.big .s { width: 24px; height: 24px; }
.s svg { width: 100%; height: 100%; fill: #4F45F9; }
.s.off svg { fill: #E1E2EC; }
.muted { color: #6b6c7e; font-size: 15px; margin-top: 6px; }
.bars { margin: 22px 0 6px; display: grid; gap: 8px; }
.bar { display: grid; grid-template-columns: 14px 1fr; align-items: center; gap: 12px; font-size: 13px; color: #6b6c7e; }
.bar b { height: 8px; border-radius: 99px; background: linear-gradient(90deg, #4F45F9 var(--w), #EEEFF5 var(--w)); }
.rev { border-top: 1px solid #EEEFF5; margin-top: 18px; padding-top: 18px; }
.who { display: flex; align-items: center; gap: 10px; font-size: 15px; margin-bottom: 8px; }
.av { width: 32px; height: 32px; border-radius: 50%; background: #EEF0FF; color: #2D2DCB; display: grid; place-items: center;
  font-weight: 700; font-size: 14px; }
.badge { margin-left: auto; font-size: 12px; font-weight: 600; color: #2D2DCB; background: #EEF0FF; border-radius: 99px; padding: 3px 10px; }
.rev p { font-size: 15px; line-height: 1.5; color: #2a2b3a; margin-top: 8px; }
"""

HEADLINE = "Bring your existing reviews with&nbsp;you."
SUB = "Import, moderate and show product reviews on Shopify. Your reviews stay in your own store."

ASSETS = {
    # Shopify App Store feature image (1600×900): benefit + product, minimal text, content kept inside the safe area.
    "app-store/proofly-feature-1600x900": (1600, 900, """
      <style>:root{--logo-h:64px;--h1:76px;--sub:26px}
      .wrap{position:absolute;inset:0;display:grid;grid-template-columns:1.05fr .95fr;align-items:center;padding:0 130px;gap:60px}
      .card{transform:scale(1.18);transform-origin:center} .g1{width:620px;height:620px;right:60px;top:140px}</style>
      <div class="glow g1"></div>
      <div class="wrap"><div><img class="logo" src="logo-trim.png" alt="Proofly">
        <h1 style="margin:56px 0 28px">{H}</h1><p class="sub">{S}</p></div>
        <div style="display:grid;place-items:center">{CARD}</div></div>"""),
    # Link preview (Open Graph / Twitter card), 1200×630.
    "social/proofly-og-1200x630": (1200, 630, """
      <style>:root{--logo-h:44px;--h1:58px;--sub:21px;--sub-w:30ch}
      .wrap{position:absolute;inset:0;display:grid;grid-template-columns:1.1fr .9fr;align-items:center;padding:0 80px;gap:40px}
      .card{transform:scale(.92)} .g1{width:460px;height:460px;right:30px;top:90px}</style>
      <div class="glow g1"></div>
      <div class="wrap"><div><img class="logo" src="logo-trim.png" alt="Proofly">
        <h1 style="margin:38px 0 20px">{H}</h1><p class="sub">{S}</p></div>
        <div style="display:grid;place-items:center">{CARD}</div></div>"""),
    # X/Twitter header, 1500×500. The profile picture covers the bottom-left, so content sits centre-right.
    "social/proofly-x-header-1500x500": (1500, 500, """
      <style>:root{--logo-h:40px;--h1:54px;--sub:20px}
      .wrap{position:absolute;inset:0;display:grid;grid-template-columns:1fr auto;align-items:center;padding:0 110px 0 470px;gap:56px}
      .card{transform:scale(.78);transform-origin:center} .g1{width:420px;height:420px;right:110px;top:40px}</style>
      <div class="glow g1"></div>
      <div class="wrap"><div><img class="logo" src="logo-trim.png" alt="Proofly"><h1 style="margin:28px 0 0">{H}</h1></div>
        <div style="width:380px;display:grid;place-items:center">{CARD}</div></div>"""),
    # LinkedIn company page cover, 1128×191: logo + proposition only (too short for the card).
    "social/proofly-linkedin-banner-1128x191": (1128, 191, """
      <style>:root{--logo-h:38px;--h1:30px;--blur:60px}
      .wrap{position:absolute;inset:0;display:flex;align-items:center;justify-content:space-between;padding:0 64px 0 300px}
      .g1{width:420px;height:260px;left:280px;top:-40px} .logo{align-self:center}</style>
      <div class="glow g1"></div>
      <div class="wrap"><h1>{H}</h1><img class="logo" src="logo-trim.png" alt="Proofly"></div>"""),
    # Facebook page cover, 1640×624 (mobile crops the sides: keep content central).
    "social/proofly-facebook-cover-1640x624": (1640, 624, """
      <style>:root{--logo-h:50px;--h1:62px;--sub:22px}
      .wrap{position:absolute;inset:0;display:grid;grid-template-columns:auto auto;justify-content:center;align-items:center;gap:90px}
      .card{transform:scale(.95)} .g1{width:520px;height:520px;left:900px;top:60px}</style>
      <div class="glow g1"></div>
      <div class="wrap"><div style="max-width:620px"><img class="logo" src="logo-trim.png" alt="Proofly">
        <h1 style="margin:40px 0 20px">{H}</h1><p class="sub">{S}</p></div>{CARD}</div>"""),
    # Square post (Instagram / LinkedIn / Facebook feed), 1080×1080.
    "social/proofly-post-1080x1080": (1080, 1080, """
      <style>:root{--logo-h:46px;--h1:68px;--sub:24px;--sub-w:36ch}
      .wrap{position:absolute;inset:0;padding:90px 90px 84px;display:flex;flex-direction:column}
      .cardwrap{margin-top:auto;align-self:center} .card{transform:scale(1.04);transform-origin:bottom center}
      .g1{width:640px;height:640px;left:220px;top:470px}</style>
      <div class="glow g1"></div>
      <div class="wrap"><img class="logo" src="logo-trim.png" alt="Proofly">
        <h1 style="margin:48px 0 20px">{H}</h1><p class="sub">{S}</p><div class="cardwrap">{CARD}</div></div>"""),
    # Vertical story / reel cover, 1080×1920; content inside the central safe zone (≈250px top and bottom).
    "social/proofly-story-1080x1920": (1080, 1920, """
      <style>:root{--logo-h:56px;--h1:96px;--sub:32px;--sub-w:24ch}
      .wrap{position:absolute;inset:0;padding:280px 100px;display:flex;flex-direction:column;align-items:flex-start}
      .cardwrap{margin-top:120px;align-self:center} .card{transform:scale(1.55);transform-origin:top center}
      .g1{width:900px;height:900px;left:90px;top:900px}</style>
      <div class="glow g1"></div>
      <div class="wrap"><img class="logo" src="logo-trim.png" alt="Proofly">
        <h1 style="margin:80px 0 32px">{H}</h1><p class="sub">{S}</p><div class="cardwrap">{CARD}</div></div>"""),
    # Profile picture: the mark centred on white, safe for circular crops.
    "social/proofly-avatar-800": (800, 800, """
      <style>:root{--mark-h:440px} body{background:#fff;display:grid;place-items:center}</style>
      <img class="mark" src="mark-trim.png" alt="Proofly">"""),
}


def render(name, w, h, body):
    html = (f"<!doctype html><html><head><meta charset='utf-8'><style>:root{{--W:{w}px;--H:{h}px}}{BASE_CSS}</style></head>"
            f"<body>{body.replace('{H}', HEADLINE).replace('{S}', SUB).replace('{CARD}', CARD)}</body></html>")
    out = ROOT / "brand" / f"{name}.png"
    out.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", suffix=".html", dir=SRC, delete=False) as f:
        f.write(html)
        page = pathlib.Path(f.name)
    try:
        subprocess.run([CHROME, "--headless=new", "--hide-scrollbars", "--force-device-scale-factor=1",
                        f"--window-size={w},{h}", "--virtual-time-budget=6000", f"--screenshot={out}",
                        page.as_uri()], check=True, capture_output=True)
    finally:
        page.unlink()
    print("wrote", out.relative_to(ROOT))


if __name__ == "__main__":
    for name, (w, h, body) in ASSETS.items():
        render(name, w, h, body)
