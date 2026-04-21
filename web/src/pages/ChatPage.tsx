/**
 * ChatPage — embeds `hermes --tui` inside the dashboard.
 *
 *   <div host> (dashboard chrome)                                         .
 *     └─ <div wrapper> (rounded, dark bg, padded — the "terminal window"  .
 *         look that gives the page a distinct visual identity)            .
 *         └─ @xterm/xterm Terminal (WebGL renderer, Unicode 11 widths)    .
 *              │ onData      keystrokes → WebSocket → PTY master          .
 *              │ onResize    terminal resize → `\x1b[RESIZE:cols;rows]`   .
 *              │ write(data) PTY output bytes → VT100 parser              .
 *              ▼                                                          .
 *     WebSocket /api/pty?token=<session>                                  .
 *          ▼                                                              .
 *     FastAPI pty_ws  (hermes_cli/web_server.py)                          .
 *          ▼                                                              .
 *     POSIX PTY → `node ui-tui/dist/entry.js` → tui_gateway + AIAgent     .
 */

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Copy } from "lucide-react";
import "@xterm/xterm/css/xterm.css";

function buildWsUrl(token: string, resume: string | null): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const qs = new URLSearchParams({ token });
  if (resume) qs.set("resume", resume);
  return `${proto}//${window.location.host}/api/pty?${qs.toString()}`;
}

// Colors for the terminal body.  Matches the dashboard's dark teal canvas
// with cream foreground — we intentionally don't pick monokai or a loud
// theme, because the TUI's skin engine already paints the content; the
// terminal chrome just needs to sit quietly inside the dashboard.
const TERMINAL_THEME = {
  background: "#0d2626",
  foreground: "#f0e6d2",
  cursor: "#f0e6d2",
  cursorAccent: "#0d2626",
  selectionBackground: "#f0e6d244",
};

export default function ChatPage() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [searchParams] = useSearchParams();
  const [banner, setBanner] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");
  const copyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const resumeRef = useRef<string | null>(searchParams.get("resume"));

  const handleCopyLast = () => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Send the slash as a burst, wait long enough for Ink's tokenizer to
    // emit a keypress event for each character (not coalesce them into a
    // paste), then send Return as its own event.  The timing here is
    // empirical — 100ms is safely past Node's default stdin coalescing
    // window and well inside UI responsiveness.
    ws.send("/copy");
    setTimeout(() => {
      const s = wsRef.current;
      if (s && s.readyState === WebSocket.OPEN) s.send("\r");
    }, 100);
    setCopyState("copied");
    if (copyResetRef.current) clearTimeout(copyResetRef.current);
    copyResetRef.current = setTimeout(() => setCopyState("idle"), 1500);
    termRef.current?.focus();
  };

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const token = window.__HERMES_SESSION_TOKEN__;
    if (!token) {
      setBanner(
        "Session token unavailable. Open this page through `hermes dashboard`, not directly.",
      );
      return;
    }

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily:
        "'JetBrains Mono', 'Cascadia Mono', 'Fira Code', 'MesloLGS NF', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
      fontSize: 14,
      lineHeight: 1.2,
      macOptionIsMeta: true,
      scrollback: 0,
      theme: TERMINAL_THEME,
    });
    termRef.current = term;

    // --- Clipboard integration ---------------------------------------
    //
    // Three independent paths all route to the system clipboard:
    //
    //   1. **Selection → Ctrl+C (or Cmd+C on macOS).**  Ink's own handler
    //      in useInputHandlers.ts turns Ctrl+C into a copy when the
    //      terminal has a selection, then emits an OSC 52 escape.  Our
    //      OSC 52 handler below decodes that escape and writes to the
    //      browser clipboard — so the flow works just like it does in
    //      `hermes --tui`.
    //
    //   2. **Ctrl/Cmd+Shift+C.**  Belt-and-suspenders shortcut that
    //      operates directly on xterm's selection, useful if the TUI
    //      ever stops listening (e.g. overlays / pickers) or if the user
    //      has selected with the mouse outside of Ink's selection model.
    //
    //   3. **Ctrl/Cmd+Shift+V.**  Reads the system clipboard and feeds
    //      it to the terminal as keyboard input.  xterm's paste() wraps
    //      it with bracketed-paste if the host has that mode enabled.
    //
    // OSC 52 reads (terminal asking to read the clipboard) are not
    // supported — that would let any content the TUI renders exfiltrate
    // the user's clipboard.
    term.parser.registerOscHandler(52, (data) => {
      // Format: "<targets>;<base64 | '?'>"
      const semi = data.indexOf(";");
      if (semi < 0) return false;
      const payload = data.slice(semi + 1);
      if (payload === "?" || payload === "") return false; // read/clear — ignore
      try {
        // atob returns a binary string (one byte per char); we need UTF-8
        // decode so multi-byte codepoints (≥, →, emoji, CJK) round-trip
        // correctly.  Without this step, the three UTF-8 bytes of `≥`
        // would land in the clipboard as the three separate Latin-1
        // characters `â‰¥`.
        const binary = atob(payload);
        const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
        const text = new TextDecoder("utf-8").decode(bytes);
        navigator.clipboard.writeText(text).catch(() => {});
      } catch {
        // Malformed base64 — silently drop.
      }
      return true;
    });

    const isMac =
      typeof navigator !== "undefined" && /Mac/i.test(navigator.platform);

    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;

      const copyModifier = isMac ? ev.metaKey : ev.ctrlKey && ev.shiftKey;
      const pasteModifier = isMac ? ev.metaKey : ev.ctrlKey && ev.shiftKey;

      if (copyModifier && ev.key.toLowerCase() === "c") {
        const sel = term.getSelection();
        if (sel) {
          navigator.clipboard.writeText(sel).catch(() => {});
          ev.preventDefault();
          return false;
        }
      }

      if (pasteModifier && ev.key.toLowerCase() === "v") {
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) term.paste(text);
          })
          .catch(() => {});
        ev.preventDefault();
        return false;
      }

      return true;
    });

    const fit = new FitAddon();
    fitRef.current = fit;
    term.loadAddon(fit);

    const unicode11 = new Unicode11Addon();
    term.loadAddon(unicode11);
    term.unicode.activeVersion = "11";

    term.loadAddon(new WebLinksAddon());

    term.open(host);

    // WebGL renderer: rasterizes glyphs to a GPU texture atlas, paints
    // each cell at an integer-pixel position.  Box-drawing glyphs connect
    // cleanly between rows (no DOM baseline / line-height math).  Falls
    // back to the default DOM renderer if WebGL is unavailable.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch (err) {
      console.warn(
        "[hermes-chat] WebGL renderer unavailable; falling back to default",
        err,
      );
    }

    fit.fit();
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // Element was removed mid-resize; cleanup will handle it.
      }
    });
    ro.observe(host);

    // WebSocket
    const url = buildWsUrl(token, resumeRef.current);
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    ws.onopen = () => {
      setBanner(null);
      ws.send(`\x1b[RESIZE:${term.cols};${term.rows}]`);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        term.write(ev.data);
      } else {
        term.write(new Uint8Array(ev.data as ArrayBuffer));
      }
    };

    ws.onclose = (ev) => {
      wsRef.current = null;
      if (ev.code === 4401) {
        setBanner(
          "Auth failed. Reload the page to refresh the session token.",
        );
        return;
      }
      if (ev.code === 4403) {
        setBanner("Chat is only reachable from localhost.");
        return;
      }
      if (ev.code === 1011) {
        // Server already wrote an ANSI error frame.
        return;
      }
      term.write("\r\n\x1b[90m[session ended]\x1b[0m\r\n");
    };

    const onDataDisposable = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data);
    });

    const onResizeDisposable = term.onResize(({ cols, rows }) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(`\x1b[RESIZE:${cols};${rows}]`);
      }
    });

    term.focus();

    return () => {
      onDataDisposable.dispose();
      onResizeDisposable.dispose();
      ro.disconnect();
      ws.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      if (copyResetRef.current) {
        clearTimeout(copyResetRef.current);
        copyResetRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Layout:
  //   outer flex column — sits inside the dashboard's content area
  //   terminal wrapper — rounded, dark, padded — the "terminal window"
  //   floating copy button — bottom-right corner, transparent with a
  //     subtle border; stays out of the way until hovered.  Sends
  //     `/copy\n` to Ink, which emits OSC 52 → our clipboard handler.
  //
  // `normal-case` opts out of the dashboard's global `uppercase` rule on
  // the root `<div>` in App.tsx — terminal output must preserve case.
  return (
    <div className="flex h-[calc(100vh-10rem)] flex-col gap-2 normal-case">
      {banner && (
        <div className="border border-warning/50 bg-warning/10 text-warning px-3 py-2 text-xs tracking-wide">
          {banner}
        </div>
      )}
      <div
        className="relative flex-1 overflow-hidden rounded-lg"
        style={{
          backgroundColor: TERMINAL_THEME.background,
          padding: "12px",
          boxShadow: "0 8px 32px rgba(0, 0, 0, 0.4)",
        }}
      >
        <div ref={hostRef} className="h-full w-full" />

        <button
          type="button"
          onClick={handleCopyLast}
          title="Copy last assistant response as raw markdown"
          aria-label="Copy last assistant response"
          className={[
            "absolute bottom-4 right-4 z-10",
            "flex items-center gap-1.5",
            "rounded border border-current/30",
            "bg-black/20 backdrop-blur-sm",
            "px-2.5 py-1.5 text-xs",
            "opacity-60 hover:opacity-100 hover:border-current/60",
            "transition-opacity duration-150",
            "focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-current",
            "cursor-pointer",
          ].join(" ")}
          style={{ color: TERMINAL_THEME.foreground }}
        >
          <Copy className="h-3 w-3" />
          <span className="tracking-wide">
            {copyState === "copied" ? "copied" : "copy last response"}
          </span>
        </button>
      </div>
    </div>
  );
}

declare global {
  interface Window {
    __HERMES_SESSION_TOKEN__?: string;
  }
}
