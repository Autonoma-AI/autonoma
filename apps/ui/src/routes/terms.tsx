import { createFileRoute } from "@tanstack/react-router";
import { LegalH2, LegalH3, LegalP, LegalPageLayout, LegalSection, LegalUL } from "components/legal-page-layout";

export const Route = createFileRoute("/terms")({
  component: TermsOfServicePage,
});

function TermsOfServicePage() {
  return (
    <LegalPageLayout title="Terms of Service" lastUpdated="May 5, 2025">
      <LegalSection>
        <LegalH2>1. Introduction</LegalH2>
        <LegalP>
          These Terms of Service (&quot;Terms&quot;) govern your access to and use of the Autonoma Bot application for
          Slack (&quot;Service&quot;), provided by Autonoma (&quot;Company,&quot; &quot;we,&quot; or &quot;us&quot;). By
          installing, accessing, or using the Service, you agree to be bound by these Terms.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>2. Acceptance of Terms</LegalH2>
        <LegalP>
          By using the Service, you affirm that you are at least 18 years of age, or the legal age of majority in your
          jurisdiction, and capable of entering into a binding agreement. If you are using the Service on behalf of an
          organization, you represent and warrant that you have authority to bind that organization to these Terms.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>3. Service Description</LegalH2>
        <LegalP>
          Autonoma Bot is a Slack integration that provides notifications of test results from the Autonoma QA platform.
          The Service connects to your Slack workspace to deliver real-time updates and information related to automated
          tests.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>4. User Accounts</LegalH2>
        <LegalP>
          To use the Service, you must have a valid Autonoma account and authorize the integration with your Slack
          workspace. You are responsible for maintaining the confidentiality of your account credentials and for all
          activities that occur under your account.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>5. Data Usage and Privacy</LegalH2>
        <LegalH3>5.1 Data Collection</LegalH3>
        <LegalP>
          When you use our Service, we collect information necessary to provide the Service, including but not limited
          to Slack workspace information, channel names, and test result data.
        </LegalP>
        <LegalH3>5.2 Data Usage</LegalH3>
        <LegalP>
          We use collected data solely for the purpose of providing, maintaining, and improving the Service.
        </LegalP>
        <LegalH3>5.3 Privacy Policy</LegalH3>
        <LegalP>
          Your use of the Service is also governed by our Privacy Policy, which is incorporated by reference into these
          Terms.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>6. Intellectual Property Rights</LegalH2>
        <LegalH3>6.1 Company Rights</LegalH3>
        <LegalP>
          All rights, title, and interest in and to the Service, including all intellectual property rights, are and
          will remain the exclusive property of the Company.
        </LegalP>
        <LegalH3>6.2 License to Use</LegalH3>
        <LegalP>
          Subject to these Terms, we grant you a limited, non-exclusive, non-transferable, and revocable license to use
          the Service.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>7. User Conduct</LegalH2>
        <LegalH3>7.1 Prohibited Activities</LegalH3>
        <LegalP>You agree not to:</LegalP>
        <LegalUL>
          <li>Use the Service in any way that violates applicable laws or regulations</li>
          <li>Interfere with or disrupt the integrity or performance of the Service</li>
          <li>Attempt to gain unauthorized access to the Service or related systems</li>
          <li>Use the Service to transmit any viruses, malware, or other harmful code</li>
          <li>Reverse engineer, decompile, or disassemble any portion of the Service</li>
        </LegalUL>
        <LegalH3>7.2 Compliance with Slack&apos;s Terms</LegalH3>
        <LegalP>
          Your use of the Service must also comply with Slack&apos;s Terms of Service and any applicable Slack policies.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>8. Third-Party Services</LegalH2>
        <LegalP>
          The Service may integrate with or contain links to third-party services. We are not responsible for the
          content or practices of these third-party services, and your use of such services is at your own risk.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>9. Disclaimer of Warranties</LegalH2>
        <LegalP>
          THE SERVICE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; WITHOUT ANY WARRANTIES OF ANY KIND,
          EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
          PARTICULAR PURPOSE, OR NON-INFRINGEMENT.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>10. Limitation of Liability</LegalH2>
        <LegalP>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, IN NO EVENT SHALL THE COMPANY BE LIABLE FOR ANY INDIRECT, INCIDENTAL,
          SPECIAL, CONSEQUENTIAL, OR PUNITIVE DAMAGES, INCLUDING WITHOUT LIMITATION, LOSS OF PROFITS, DATA, USE,
          GOODWILL, OR OTHER INTANGIBLE LOSSES, RESULTING FROM YOUR ACCESS TO OR USE OF OR INABILITY TO ACCESS OR USE
          THE SERVICE.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>11. Indemnification</LegalH2>
        <LegalP>
          You agree to defend, indemnify, and hold harmless the Company and its officers, directors, employees, and
          agents from and against any claims, liabilities, damages, losses, and expenses, including reasonable
          attorneys&apos; fees, arising out of or in any way connected with your access to or use of the Service.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>12. Modifications to Service and Terms</LegalH2>
        <LegalH3>12.1 Service Modifications</LegalH3>
        <LegalP>
          We reserve the right to modify or discontinue, temporarily or permanently, the Service with or without notice.
        </LegalP>
        <LegalH3>12.2 Terms Modifications</LegalH3>
        <LegalP>
          We may revise these Terms from time to time. The most current version will always be posted on our website. By
          continuing to use the Service after revisions become effective, you agree to be bound by the revised Terms.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>13. Termination</LegalH2>
        <LegalH3>13.1 Termination by You</LegalH3>
        <LegalP>
          You may terminate your use of the Service at any time by uninstalling the Autonoma Bot from your Slack
          workspace.
        </LegalP>
        <LegalH3>13.2 Termination by Us</LegalH3>
        <LegalP>
          We may terminate or suspend your access to the Service immediately, without prior notice or liability, for any
          reason.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>14. Governing Law</LegalH2>
        <LegalP>
          These Terms shall be governed by and construed in accordance with the laws of the State of Delaware, United
          States, without regard to its conflict of law provisions.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>15. Dispute Resolution</LegalH2>
        <LegalP>
          Any dispute arising from or relating to these Terms or the Service shall be resolved through binding
          arbitration in accordance with the commercial arbitration rules of the American Arbitration Association in the
          State of Delaware, United States.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>16. Severability</LegalH2>
        <LegalP>
          If any provision of these Terms is found to be unenforceable or invalid, that provision shall be limited or
          eliminated to the minimum extent necessary so that these Terms shall otherwise remain in full force and
          effect.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>17. Entire Agreement</LegalH2>
        <LegalP>
          These Terms constitute the entire agreement between you and the Company regarding the Service and supersede
          all prior and contemporaneous agreements, proposals, or representations, written or oral, concerning the
          subject matter.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>18. Contact Information</LegalH2>
        <LegalP>If you have any questions about these Terms, please contact us at:</LegalP>
        <LegalUL>
          <li>Email: support@autonoma.app</li>
          <li>Address: Autonoma Inc., 251 Little Falls Drive, Wilmington, Delaware 19801, United States</li>
        </LegalUL>
      </LegalSection>
    </LegalPageLayout>
  );
}
