import SealForm from "./SealForm";

const REPO = "https://github.com/idonov8/hetzner-mcp";
// Set by Vercel at build time for git-backed deployments.
const COMMIT = process.env.VERCEL_GIT_COMMIT_SHA ?? "";

const TOOLS: Array<[string, string]> = [
  ["list_servers", "Specs, location, IPs, image, protection, traffic and monthly price per server"],
  ["server_usage", "CPU, disk and network averages over 1h / 24h / 7d / 30d"],
  ["server_timeseries", "The same metrics as a time series, for charts"],
  ["recent_actions", "Reboots, rebuilds, backups and other server actions, newest first"],
  ["backups_and_snapshots", "Backup and snapshot images with size, age and cost"],
  ["cost_breakdown", "Monthly cost of every billed resource"],
  ["security_overview", "Firewalls, ports open to the world, SSH/ICMP exposure"],
];

export default function Home() {
  return (
    <main>
      <div className="topbar">
        {COMMIT ? (
          <a
            className="commit mono"
            href={`${REPO}/commit/${COMMIT}`}
            title="The commit this deployment was built from"
          >
            {COMMIT.slice(0, 7)}
          </a>
        ) : (
          <span className="commit mono" title="Not built from a git commit">
            local
          </span>
        )}
        <a className="gh" href={REPO} aria-label="Source code on GitHub" title="Source code on GitHub">
          <svg viewBox="0 0 16 16" width="26" height="26" aria-hidden="true" fill="currentColor">
            <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
          </svg>
        </a>
      </div>
      <h1>
        Free, easy, vibe-coded MCP for <span className="accent">hetzner</span>
      </h1>
      <p className="lede">
        Give Claude a read-only view of your Hetzner Cloud servers, usage, costs and firewall exposure. Paste a token,
        get a URL, add it as a connector. No sign-up, no database.
      </p>
      <ul className="badges">
        <li>read-only</li>
        <li>nothing stored</li>
        <li>open source</li>
        <li>multi-project</li>
      </ul>

      <h2>1. Get a read-only token</h2>
      <ol className="guide">
        <li>
          Open the <a href="https://console.hetzner.com/projects">Hetzner Console</a>
        </li>
        <li>Pick your project</li>
        <li>
          <strong>Security</strong> → <strong>API tokens</strong>
        </li>
        <li>
          <strong>Generate API token</strong> with permission <strong>Read</strong>, then copy it
        </li>
      </ol>
      <p className="hint">Tokens are per project. For several projects, make one token in each and add them all.</p>

      <h2>2. Create your MCP URL</h2>
      <SealForm />

      <h2>How it works</h2>
      <div className="flow">
        <div>
          <strong>You paste a Read token</strong>
          The server makes one GET call to Hetzner to check that the token works.
        </div>
        <div>
          <strong>It gets encrypted</strong>
          Your project names and tokens are encrypted with AES-256-GCM using a key only this server has.
        </div>
        <div>
          <strong>The URL is the ciphertext</strong>
          The encrypted blob becomes the last part of your MCP URL. Nothing is saved anywhere.
        </div>
        <div>
          <strong>Claude calls the URL</strong>
          Each request is decrypted in memory and turned into read-only GET calls to Hetzner.
        </div>
      </div>
      <p>
        There are no accounts because there is nothing to log into: the URL carries everything. Tampered or made-up
        URLs fail decryption and get a plain 404. Request logs only ever show the encrypted blob, never your token.
      </p>

      <h2>What that means for you</h2>
      <ul className="plain">
        <li>
          <strong>The URL is a password.</strong> Anyone who has it can read what the tools below return for your
          projects: server names, IPs, costs, which ports are open. They cannot change anything.
        </li>
        <li>
          <strong>Revoke by deleting the token</strong> in the Hetzner Console. The URL stops working immediately.
          There is no other way to revoke one URL, and nothing to delete here.
        </li>
        <li>
          <strong>Use a Read token.</strong> The server only ever sends GET requests, but a Read token means even a
          leak can&apos;t become a write.
        </li>
        <li>
          <strong>You are trusting this server.</strong> It holds the key that decrypts your URL. If that bothers you,
          the code is public: <a href={REPO}>deploy your own copy</a> to Vercel in a few minutes.
        </li>
      </ul>

      <h2>Tools Claude gets</h2>
      <table>
        <tbody>
          {TOOLS.map(([name, what]) => (
            <tr key={name}>
              <td className="mono">{name}</td>
              <td>{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="hint">
        With several projects in one URL, every row is tagged with its project name and all projects are queried in
        parallel.
      </p>

      <footer>
        Vibe-coded, provided as is, not affiliated with Hetzner. Source on <a href={REPO}>GitHub</a>.
      </footer>
    </main>
  );
}
