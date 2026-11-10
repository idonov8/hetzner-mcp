"use client";

import { useState } from "react";

type Row = { name: string; token: string; consoleId: string };

const emptyRow = (name = ""): Row => ({ name, token: "", consoleId: "" });

export default function SealForm() {
  const [rows, setRows] = useState<Row[]>([emptyRow("main")]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const update = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setUrl(null);
    setCopied(false);
    try {
      const res = await fetch("/api/seal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projects: rows }),
      });
      const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !body.url) throw new Error(body.error ?? `Request failed (${res.status})`);
      setUrl(body.url);
      // The tokens are now inside the URL; don't keep plaintext copies on screen.
      setRows((rs) => rs.map((r) => ({ ...r, token: "" })));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <form className="card" onSubmit={submit} autoComplete="off">
      <div className="row row-head" aria-hidden>
        <span>Project name</span>
        <span>Read-only API token</span>
        <span>Console id (optional)</span>
        <span />
      </div>
      {rows.map((r, i) => (
        <div className="row" key={i}>
          <input
            className="name"
            aria-label="Project name"
            placeholder="name"
            value={r.name}
            maxLength={32}
            pattern="[a-z0-9_\-]{1,32}"
            title="1-32 chars: a-z, 0-9, _ or -"
            required
            onChange={(e) => update(i, { name: e.target.value.toLowerCase() })}
          />
          <input
            className="token"
            aria-label="Read-only Hetzner API token"
            placeholder="Hetzner API token (Read)"
            type="password"
            value={r.token}
            required
            spellCheck={false}
            onChange={(e) => update(i, { token: e.target.value })}
          />
          <input
            className="cid"
            aria-label="Console project id (optional)"
            placeholder="console id"
            inputMode="numeric"
            pattern="\d{1,20}"
            title="The number in console.hetzner.com/projects/<id>"
            value={r.consoleId}
            onChange={(e) => update(i, { consoleId: e.target.value.trim() })}
          />
          <button
            type="button"
            className="icon remove"
            aria-label="Remove project"
            disabled={rows.length === 1}
            onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}
          >
            ×
          </button>
        </div>
      ))}

      <div className="actions">
        {rows.length < 10 && (
          <button type="button" onClick={() => setRows((rs) => [...rs, emptyRow()])}>
            + Add project
          </button>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "Checking tokens…" : "Create MCP URL"}
        </button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}

      {url && (
        <div className="result">
          <div className="label">Your MCP URL is ready. Treat it like a password.</div>
          <div className="urlbox">
            <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="MCP URL" />
            <button type="button" className="primary" onClick={copy}>
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <ol className="steps hint">
            <li>
              In Claude: <strong>Settings → Connectors → Add custom connector</strong>.
            </li>
            <li>
              Name it <code>Hetzner</code>, paste the URL, leave OAuth empty.
            </li>
            <li>Ask Claude things like “what are my servers costing me?” or “anything exposed to the internet?”</li>
          </ol>
        </div>
      )}
    </form>
  );
}
