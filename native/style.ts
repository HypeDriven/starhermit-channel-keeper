// The look of the menus, HUD and sheets: the browser build's style sheet,
// rewritten class-based in tools/ui-style.css and converted once with
// `starhermit css` into assets/ui-style.json (`npm run css`), registered at
// start. High contrast and the text size are the runtime's (it forces the
// UI's colours and scales its text).
import { files } from "starhermit:engine";
import * as ui from "starhermit:ui";

export const COLORS = {
  bg: "#0b0e14", panel: "#151a24", panel2: "#1c2330", text: "#e8edf4", dim: "#9aa7b8",
  accent: "#3ec6ff", accent2: "#7dffc8", danger: "#ff6050", water: "#3ec6ff", focus: "#ffd75e", line: "#2c3648",
};

export function initStyles(): void {
  const css = files.readJson("assets/ui-style.json") as unknown as ui.CssStyles;
  ui.setTheme({
    fontSize: 16, smallSize: 13.6, headingSize: 24, padding: 8, spacing: 8, radius: 10,
    text: COLORS.text, muted: COLORS.dim, panel: COLORS.panel, control: COLORS.panel2, hovered: "#243043",
    pressed: "#14425c", field: COLORS.panel2, accent: COLORS.accent, focus: COLORS.focus, outline: COLORS.line,
  });
  ui.setTokens(css.tokens);
  ui.setAnimations(css.animations);
  ui.setStyles({
    ...css.styles,
    label: { text: { color: "$text" } },
    paragraph: { text: { color: "$text" } },
    heading: { text: { color: "$text" } },
    widget: { focusRing: { color: "$focus", width: 3, offset: 2 } },
    checkbox: {
      text: { color: "$text" }, minHeight: 36,
      parts: { box: { background: "$panel-2", border: { width: 1, color: "$line" }, radius: 4 }, mark: { background: "$accent" } },
    },
    select: { text: { color: "$text" }, background: "$panel-2", border: { width: 1, color: "$line" }, radius: 6, minHeight: 36 },
    dialog: {
      background: "$panel", radius: 14, padding: 22, border: { width: 1, color: "$line" },
      parts: { backdrop: { background: "#04070cb8" } },
    },
    scrollArea: { parts: { bar: { background: "$dim", radius: 4 } } },
    tooltip: { background: "$text", text: { color: "$bg" }, radius: 6, padding: 6 },
  });
}
