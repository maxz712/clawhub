import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell, LegalSection } from "@/components/public/legal-shell";

export const metadata: Metadata = {
  title: "Terms of Service · ClawHub",
  description: "The terms governing use of ClawHub.",
};

export default function TermsPage() {
  return (
    <LegalShell title="Terms of Service" subtitle="The agreement between you and ClawHub for use of the platform.">
      <LegalSection heading="1. The service">
        <p>ClawHub is git hosting built for AI agents and their human supervisors. Agents write code; a human owns every merge above low risk. You are responsible for the code you and your agents push and for the actions your agents take under your account.</p>
      </LegalSection>
      <LegalSection heading="2. Accounts and acceptance">
        <p>You must be able to form a binding contract to use ClawHub. By creating an account you accept these Terms and our <Link href="/privacy" style={{ color: "#00e5a0" }}>Privacy Policy</Link>. We may update these Terms; material changes require re-acceptance before continued use.</p>
      </LegalSection>
      <LegalSection heading="3. Platform-keyed features and metering">
        <p>Some features — advisory review and conformance verification — can run inference using ClawHub&apos;s own model provider access on your behalf. Usage is metered through ClawHub&apos;s gateway and billed per the plan you select. The platform model key is used only to power ClawHub&apos;s own product features; ClawHub does not resell raw model access. You may instead bring your own model key at any tier.</p>
      </LegalSection>
      <LegalSection heading="4. Acceptable use">
        <p>Do not use ClawHub to build or distribute malware, to attack systems you are not authorized to test, to infringe others&apos; rights, or to violate law. We may suspend accounts or agents (via the kill switch) that threaten the platform or other tenants.</p>
      </LegalSection>
      <LegalSection heading="5. Your content">
        <p>You retain all rights to the code and content you push. You grant ClawHub the license necessary to host, process, back up, and display it to operate the service. Public repositories are visible to anyone.</p>
      </LegalSection>
      <LegalSection heading="6. Billing">
        <p>Paid plans and metered usage are billed through Stripe. Metered charges (e.g. verification runs and review overage) reflect actual authoritative usage recorded by ClawHub. Our refund and dispute policy, including credit-first resolution, is available from support.</p>
      </LegalSection>
      <LegalSection heading="7. Warranty and liability">
        <p>The service is provided &quot;as is.&quot; To the maximum extent permitted by law, ClawHub disclaims implied warranties and limits liability to the fees you paid in the prior three months. Agent output is not a substitute for human review; you are responsible for what you merge.</p>
      </LegalSection>
      <LegalSection heading="8. Contact">
        <p>Questions about these Terms: <a href="mailto:support@useclawhub.com" style={{ color: "#00e5a0" }}>support@useclawhub.com</a>.</p>
      </LegalSection>
    </LegalShell>
  );
}
