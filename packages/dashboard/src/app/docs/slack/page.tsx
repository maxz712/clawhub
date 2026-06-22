import { PublicHeader } from "@/components/public/public-header";
import { PublicFooter } from "@/components/public/public-footer";

const mono = "var(--font-jbmono), monospace";

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code
      style={{
        fontFamily: mono,
        fontSize: 13,
        color: "#00e5a0",
        background: "rgba(0,229,160,0.1)",
        padding: "2px 6px",
        borderRadius: 4,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </code>
  );
}

function Pre({ children }: { children: React.ReactNode }) {
  return (
    <pre
      style={{
        fontFamily: mono,
        fontSize: 13,
        lineHeight: 1.7,
        color: "#c0c0d0",
        background: "#111116",
        border: "1px solid #2a2a33",
        borderRadius: 8,
        padding: "16px 18px",
        overflowX: "auto",
        margin: "16px 0",
      }}
    >
      {children}
    </pre>
  );
}

function H2({ children }: { children: React.ReactNode }) {
  return (
    <h2 style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.5px", margin: "48px 0 14px" }}>
      {children}
    </h2>
  );
}

function H3({ children }: { children: React.ReactNode }) {
  return (
    <h3 style={{ fontSize: 18, fontWeight: 600, margin: "28px 0 10px" }}>{children}</h3>
  );
}

function P({ children }: { children: React.ReactNode }) {
  return <p style={{ color: "#c0c0d0", lineHeight: 1.7, margin: "0 0 14px" }}>{children}</p>;
}

export default function SlackDocsPage() {
  return (
    <div
      style={{
        background: "#0a0a0c",
        color: "#e8e8ed",
        minHeight: "100vh",
        fontFamily: "var(--font-outfit), sans-serif",
      }}
    >
      <PublicHeader />

      <div style={{ maxWidth: 760, margin: "0 auto", padding: "60px 24px 80px" }}>
        <div
          style={{
            fontFamily: mono,
            color: "#00e5a0",
            fontSize: 12,
            textTransform: "uppercase",
            letterSpacing: 3,
            marginBottom: 12,
          }}
        >
          Docs
        </div>
        <h1 style={{ fontSize: 48, fontWeight: 800, letterSpacing: "-1.5px", margin: 0 }}>
          ClawHub for Slack
        </h1>
        <p style={{ color: "#8888a0", margin: "8px 0 0", fontSize: 17, lineHeight: 1.6 }}>
          Run a <Code>/clawhub</Code> slash command in any Slack channel to check service
          health and look up public Changes — without leaving chat.
        </p>

        <H2>Add the slash command</H2>
        <P>
          ClawHub exposes a single Slack endpoint. Point a Slack app&apos;s slash command at it
          and share the signing secret so every request can be HMAC-verified.
        </P>
        <ol style={{ color: "#c0c0d0", lineHeight: 1.8, paddingLeft: 22, margin: "0 0 8px" }}>
          <li>
            Create a Slack app at{" "}
            <a href="https://api.slack.com/apps" style={{ color: "#00e5a0" }}>
              api.slack.com/apps
            </a>{" "}
            (From scratch is fine), and pick the workspace it should live in.
          </li>
          <li>
            Under <strong>Slash Commands</strong>, add a new command named{" "}
            <Code>/clawhub</Code>.
          </li>
          <li>
            Set its <strong>Request URL</strong> to your ClawHub API&apos;s chatops endpoint:
          </li>
        </ol>
        <Pre>https://&lt;your-clawhub&gt;/api/v1/chatops/slack</Pre>
        <ol
          start={4}
          style={{ color: "#c0c0d0", lineHeight: 1.8, paddingLeft: 22, margin: "0 0 8px" }}
        >
          <li>
            Copy the app&apos;s <strong>Signing Secret</strong> (Basic Information → App
            Credentials) and set it on the ClawHub server as an environment variable:
          </li>
        </ol>
        <Pre>CLAWHUB_SLACK_SIGNING_SECRET=your-slack-signing-secret</Pre>
        <P>
          ClawHub verifies the <Code>x-slack-signature</Code> header against this secret on every
          request. If <Code>CLAWHUB_SLACK_SIGNING_SECRET</Code> is unset, all requests are
          rejected — the integration is off by default.
        </P>
        <ol
          start={5}
          style={{ color: "#c0c0d0", lineHeight: 1.8, paddingLeft: 22, margin: "0 0 8px" }}
        >
          <li>Install the app to your workspace. The command is now live.</li>
        </ol>

        <H2>Available commands</H2>

        <H3>
          <Code>/clawhub status</Code>
        </H3>
        <P>Returns a quick service health summary for your ClawHub instance.</P>
        <Pre>{`/clawhub status
→ ClawHub is up.`}</Pre>

        <H3>
          <Code>/clawhub change &lt;change-id&gt;</Code>
        </H3>
        <P>
          Looks up a Change by its UUID and replies with its intent, status, computed risk, and a
          link to the Change in the dashboard.
        </P>
        <Pre>{`/clawhub change 3f2a9c10-7b54-4e2e-9a1f-2c6d8e0b1a44
→ *Tighten merge policy on deploy paths* — status: approved, risk: high.
  https://<your-clawhub>/r/<ns>/<repo>/changes/3f2a9c10-…`}</Pre>
        <div
          style={{
            background: "rgba(0,229,160,0.06)",
            border: "1px solid #2a2a33",
            borderLeft: "3px solid #00e5a0",
            borderRadius: 8,
            padding: "14px 18px",
            margin: "8px 0 0",
          }}
        >
          <P>
            <strong>Public repos only.</strong> A Slack request isn&apos;t an authenticated
            ClawHub user, so lookups surface only Changes in <strong>public</strong> repositories.
            Changes in private repos return as not found — they never leak into chat.
          </P>
        </div>

        <H2>Approving a Change is not a Slack command</H2>
        <P>
          There is deliberately no <Code>/clawhub approve</Code>. Approval in ClawHub must rest on
          the actual code — the Review-Focus gate puts the flagged lines in front of a human
          before they sign off. A one-word chat command can&apos;t carry that judgment, so it
          would be misleading.
        </P>
        <P>
          The old <Code>/clawhub approve</Code> was a no-op that pretended to approve, and it has
          been removed. Review and merge a Change in the dashboard, where you can see the diff,
          the focused review, and the evidence.
        </P>

        <H2>Discord</H2>
        <P>
          Discord works the same way through a separate endpoint. Add a <Code>clawhub</Code>{" "}
          application command and point its interactions Request URL at:
        </P>
        <Pre>https://&lt;your-clawhub&gt;/api/v1/chatops/discord</Pre>
        <P>
          Set your app&apos;s <strong>Public Key</strong> (from the Discord Developer Portal) as
          the ClawHub server env var:
        </P>
        <Pre>CLAWHUB_DISCORD_PUBLIC_KEY=your-discord-public-key</Pre>
        <P>
          ClawHub verifies each interaction&apos;s Ed25519 signature against this key (and answers
          Discord&apos;s ping). As with Slack, lookups are limited to public repos and approving a
          Change still happens in the dashboard.
        </P>
      </div>

      <PublicFooter />
    </div>
  );
}
