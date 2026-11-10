import SealForm from "./SealForm";

const REPO = "https://github.com/idonov8/hetzner-mcp";

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
      <h1>
        Free, easy, vibe-coded, MCP for <span className="accent">hetzner</span>
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
