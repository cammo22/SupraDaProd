// Renders the app icon (1024² PNG) from an SVG so it can be tweaked as code.
//   npm run icons   → this script, then `tauri icon` fans it out to every platform size
import { Resvg } from "@resvg/resvg-js";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
  <defs>
    <radialGradient id="v" cx="22%" cy="18%" r="75%"><stop offset="0" stop-color="#8b6bff"/><stop offset="1" stop-color="#8b6bff" stop-opacity="0"/></radialGradient>
    <radialGradient id="c" cx="85%" cy="88%" r="70%"><stop offset="0" stop-color="#00e5ff"/><stop offset="1" stop-color="#00e5ff" stop-opacity="0"/></radialGradient>
    <radialGradient id="p" cx="78%" cy="20%" r="55%"><stop offset="0" stop-color="#ff5fd2" stop-opacity=".85"/><stop offset="1" stop-color="#ff5fd2" stop-opacity="0"/></radialGradient>
    <linearGradient id="bolt" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#d9e9ff"/></linearGradient>
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="26"/></filter>
    <clipPath id="r"><rect width="1024" height="1024" rx="228"/></clipPath>
  </defs>
  <g clip-path="url(#r)">
    <rect width="1024" height="1024" fill="#0a0920"/>
    <rect width="1024" height="1024" fill="url(#v)"/>
    <rect width="1024" height="1024" fill="url(#c)"/>
    <rect width="1024" height="1024" fill="url(#p)"/>
    <!-- latent-noise grid fading into the picture: the "image condensing from noise" idea -->
    <g fill="#fff" opacity=".10">
      ${Array.from({ length: 12 }, (_, y) =>
        Array.from({ length: 12 }, (_, x) => {
          const k = ((x * 7 + y * 13 + x * y) % 5);
          return k < 2 ? `<rect x="${64 + x * 77}" y="${64 + y * 77}" width="${k ? 22 : 34}" height="${k ? 22 : 34}" rx="6"/>` : "";
        }).join("")).join("")}
    </g>
    <path d="M590 130 300 560h190l-60 330 300-470H540z" fill="#7c5cff" filter="url(#glow)" opacity=".9"/>
    <path d="M590 130 300 560h190l-60 330 300-470H540z" fill="url(#bolt)"/>
    <path d="M800 190l18 50 50 18-50 18-18 50-18-50-50-18 50-18z" fill="#fff" opacity=".95"/>
    <path d="M232 716l11 30 30 11-30 11-11 30-11-30-30-11 30-11z" fill="#fff" opacity=".8"/>
  </g>
</svg>`;

const png = new Resvg(svg, { fitTo: { mode: "width", value: 1024 } }).render().asPng();
const out = resolve(import.meta.dirname, "../app-icon.png");
writeFileSync(out, png);
writeFileSync(resolve(import.meta.dirname, "../public/favicon.svg"), svg);
console.log("wrote", out, `${(png.length / 1024).toFixed(0)} KB`);

// Android adaptive icons need a background colour that matches the art.
const bg = resolve(import.meta.dirname, "../src-tauri/icons/android/values/ic_launcher_background.xml");
if (existsSync(bg)) writeFileSync(bg, readFileSync(bg, "utf8").replace(/#[0-9a-fA-F]{3,8}/, "#0a0920"));
