import type { Metadata } from "next";
import Link from "next/link";
import { LegalShell, LegalSection } from "@/components/public/legal-shell";
import { SUBPROCESSORS } from "@/lib/legal";

export const metadata: Metadata = {
  title: "Privacy Policy · ClawHub",
  description: "How ClawHub collects, uses, and protects your data, and the subprocessors it relies on.",
};

export default function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy" subtitle="What ClawHub collects, why, and the subprocessors it relies on.">
      <LegalSection heading="1. What we collect">
        <p>Account data (email, handle, and, if you use OAuth, your provider identity), the repositories and content you push, activity needed to run reviews and CI, and billing data processed by Stripe. For platform-keyed features we record token usage and cost per request to meter and bill accurately.</p>
      </LegalSection>
      <LegalSection heading="2. How we use it">
        <p>To operate the service — host your repos, run reviews and verification, enforce the merge gate, bill usage, send transactional email, and secure the platform. We do not sell your personal data. Your code is not used to train third-party models beyond serving your own requests.</p>
      </LegalSection>
      <LegalSection heading="3. Subprocessors">
        <p>We share the minimum data necessary with the following subprocessors to run the platform:</p>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14, marginTop: 4 }}>
            <thead>
              <tr style={{ textAlign: "left", color: "#8888a0", borderBottom: "1px solid #2a2a33" }}>
                <th style={{ padding: "8px 10px", fontWeight: 600 }}>Subprocessor</th>
                <th style={{ padding: "8px 10px", fontWeight: 600 }}>Purpose</th>
                <th style={{ padding: "8px 10px", fontWeight: 600 }}>Location</th>
              </tr>
            </thead>
            <tbody>
              {SUBPROCESSORS.map(s => (
                <tr key={s.name} style={{ borderBottom: "1px solid #1c1c22" }}>
                  <td style={{ padding: "8px 10px", color: "#e8e8ed", fontWeight: 600, whiteSpace: "nowrap" }}>{s.name}</td>
                  <td style={{ padding: "8px 10px", color: "#c5c5d2" }}>{s.purpose}</td>
                  <td style={{ padding: "8px 10px", color: "#8888a0", whiteSpace: "nowrap" }}>{s.location}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </LegalSection>
      <LegalSection heading="4. Data retention">
        <p>We keep account and content data while your account is active. Billing and usage records (token counts and cost) are retained as financial records even after account deletion, but the personal attribution linking them to you is removed. You can request export or deletion at any time.</p>
      </LegalSection>
      <LegalSection heading="5. Your rights">
        <p>You can export your data or request deletion from your account settings, or by contacting us. We honor GDPR/CCPA rights including access, portability, and erasure. Deletion scrubs personal attribution while retaining anonymized financial records as described above.</p>
      </LegalSection>
      <LegalSection heading="6. Model provider and retention">
        <p>Platform-keyed inference is served by Anthropic through ClawHub&apos;s metering gateway. We are confirming zero-retention / no-training terms for this usage; until confirmed you can bring your own key or self-host to keep inference entirely under your control. See the <Link href="/terms" style={{ color: "#00e5a0" }}>Terms of Service</Link>.</p>
      </LegalSection>
      <LegalSection heading="7. Contact and DPA">
        <p>Privacy questions or a Data Processing Addendum: <a href="mailto:privacy@useclawhub.com" style={{ color: "#00e5a0" }}>privacy@useclawhub.com</a>. A DPA is available on request.</p>
      </LegalSection>
    </LegalShell>
  );
}
