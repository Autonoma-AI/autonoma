import { createFileRoute } from "@tanstack/react-router";
import { LegalH2, LegalH3, LegalP, LegalPageLayout, LegalSection, LegalUL } from "components/legal-page-layout";

export const Route = createFileRoute("/eula")({
  component: EulaPage,
});

function EulaPage() {
  return (
    <LegalPageLayout title="End User License Agreement" lastUpdated="October 10, 2025">
      <LegalSection>
        <LegalH2>1. Introduction</LegalH2>
        <LegalP>
          This End User License Agreement (&quot;Agreement&quot; or &quot;EULA&quot;) is a legal agreement between you
          (&quot;User,&quot; &quot;you,&quot; or &quot;your&quot;) and Autonoma Inc. (&quot;Company,&quot;
          &quot;we,&quot; &quot;us,&quot; or &quot;our&quot;) governing your use of Autonoma AI and related software
          applications (&quot;Software&quot; or &quot;Service&quot;). By installing, accessing, or using the Software,
          you agree to be bound by the terms of this Agreement.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>2. Acceptance of Terms</LegalH2>
        <LegalP>
          By creating an account, downloading, installing, or using the Software, you acknowledge that you have read,
          understood, and agree to be bound by this Agreement. If you do not agree to these terms, do not install or use
          the Software.
        </LegalP>
        <LegalP>
          If you are using the Software on behalf of an organization, you represent and warrant that you have the
          authority to bind that organization to these terms, and your acceptance of this Agreement will be treated as
          acceptance by that organization.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>3. License Grant</LegalH2>
        <LegalH3>3.1 Grant of License</LegalH3>
        <LegalP>
          Subject to your compliance with this Agreement, we grant you a limited, non-exclusive, non-transferable,
          revocable license to download, install, and use the Software for your personal or internal business purposes
          in accordance with this Agreement and any applicable documentation.
        </LegalP>
        <LegalH3>3.2 License Restrictions</LegalH3>
        <LegalP>You agree not to:</LegalP>
        <LegalUL>
          <li>Copy, modify, or create derivative works based on the Software</li>
          <li>Distribute, transfer, sublicense, lease, lend, or rent the Software</li>
          <li>Reverse engineer, decompile, disassemble, or attempt to derive the source code of the Software</li>
          <li>Remove, alter, or obscure any proprietary notice or labels on the Software</li>
          <li>Use the Software for any illegal or unauthorized purpose</li>
          <li>Use the Software to develop competing products or services</li>
          <li>Attempt to gain unauthorized access to the Software or its related systems or networks</li>
          <li>Interfere with or disrupt the integrity or performance of the Software</li>
        </LegalUL>
      </LegalSection>

      <LegalSection>
        <LegalH2>4. User Accounts and Responsibilities</LegalH2>
        <LegalH3>4.1 Account Creation</LegalH3>
        <LegalP>
          To access certain features of the Software, you may be required to create an account. You agree to provide
          accurate, current, and complete information during the registration process and to update such information to
          keep it accurate, current, and complete.
        </LegalP>
        <LegalH3>4.2 Account Security</LegalH3>
        <LegalP>
          You are responsible for maintaining the confidentiality of your account credentials and for all activities
          that occur under your account. You agree to immediately notify us of any unauthorized use of your account or
          any other breach of security.
        </LegalP>
        <LegalH3>4.3 User Conduct</LegalH3>
        <LegalP>
          You agree to use the Software in compliance with all applicable laws and regulations and in accordance with
          this Agreement. You are solely responsible for your conduct and any data, text, information, or other content
          that you submit or transmit through the Software.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>5. Intellectual Property Rights</LegalH2>
        <LegalH3>5.1 Ownership</LegalH3>
        <LegalP>
          The Software and all worldwide intellectual property rights therein are the exclusive property of Autonoma
          Inc. and its licensors. All rights not expressly granted to you in this Agreement are reserved by the Company
          and its licensors.
        </LegalP>
        <LegalH3>5.2 Trademarks</LegalH3>
        <LegalP>
          Autonoma AI, the Autonoma logo, and other Company trademarks, service marks, graphics, and logos used in
          connection with the Software are trademarks or registered trademarks of Autonoma Inc. Other trademarks,
          service marks, graphics, and logos used in connection with the Software may be the trademarks of their
          respective owners.
        </LegalP>
        <LegalH3>5.3 User Content</LegalH3>
        <LegalP>
          You retain all rights to any content you submit, post, or display through the Software. By submitting content,
          you grant the Company a worldwide, non-exclusive, royalty-free license to use, reproduce, process, and display
          such content solely for the purpose of providing the Software to you.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>6. Privacy and Data Protection</LegalH2>
        <LegalP>
          Your use of the Software is subject to our Privacy Policy, which is incorporated by reference into this
          Agreement. By using the Software, you consent to the collection, use, and sharing of your information as
          described in our Privacy Policy.
        </LegalP>
        <LegalP>
          We implement reasonable security measures to protect your data. However, no method of transmission over the
          Internet or electronic storage is completely secure. We cannot guarantee absolute security of your data.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>7. Updates and Modifications</LegalH2>
        <LegalH3>7.1 Software Updates</LegalH3>
        <LegalP>
          We may from time to time provide updates, upgrades, or new versions of the Software. Such updates may be
          automatically downloaded and installed without prior notice to you. You consent to such automatic updates.
        </LegalP>
        <LegalH3>7.2 Agreement Modifications</LegalH3>
        <LegalP>
          We reserve the right to modify this Agreement at any time. We will notify you of any material changes by
          posting the new Agreement on our website or through the Software. Your continued use of the Software after
          such modifications constitutes your acceptance of the updated Agreement.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>8. Subscription and Payment Terms</LegalH2>
        <LegalH3>8.1 Subscription Plans</LegalH3>
        <LegalP>
          Certain features of the Software may require payment of subscription fees. The terms of your subscription,
          including pricing and billing frequency, will be specified at the time of purchase.
        </LegalP>
        <LegalH3>8.2 Payment</LegalH3>
        <LegalP>
          You agree to pay all applicable fees associated with your subscription. All fees are non-refundable except as
          required by law or as explicitly stated in this Agreement.
        </LegalP>
        <LegalH3>8.3 Automatic Renewal</LegalH3>
        <LegalP>
          Your subscription will automatically renew at the end of each subscription period unless you cancel before the
          renewal date. You may cancel your subscription at any time through your account settings or by contacting us.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>9. Disclaimer of Warranties</LegalH2>
        <LegalP>
          THE SOFTWARE IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot; WITHOUT WARRANTIES OF ANY KIND, EITHER
          EXPRESS OR IMPLIED, INCLUDING, BUT NOT LIMITED TO, IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
          PARTICULAR PURPOSE, NON-INFRINGEMENT, OR COURSE OF PERFORMANCE.
        </LegalP>
        <LegalP>
          The Company does not warrant that the Software will be uninterrupted, error-free, or free of viruses or other
          harmful components. The Company does not warrant or make any representations regarding the use or results of
          the Software in terms of correctness, accuracy, reliability, or otherwise.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>10. Limitation of Liability</LegalH2>
        <LegalP>
          TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, IN NO EVENT SHALL AUTONOMA INC., ITS AFFILIATES, OFFICERS,
          DIRECTORS, EMPLOYEES, AGENTS, OR LICENSORS BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, OR
          PUNITIVE DAMAGES, INCLUDING WITHOUT LIMITATION, LOSS OF PROFITS, DATA, USE, GOODWILL, OR OTHER INTANGIBLE
          LOSSES, RESULTING FROM:
        </LegalP>
        <LegalUL>
          <li>Your access to or use of or inability to access or use the Software</li>
          <li>Any conduct or content of any third party on the Software</li>
          <li>Any content obtained from the Software</li>
          <li>Unauthorized access, use, or alteration of your transmissions or content</li>
        </LegalUL>
        <LegalP>
          In no event shall the Company&apos;s total liability to you for all damages exceed the amount paid by you to
          the Company in the twelve (12) months preceding the claim, or one hundred dollars ($100), whichever is
          greater.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>11. Indemnification</LegalH2>
        <LegalP>
          You agree to defend, indemnify, and hold harmless Autonoma Inc., its affiliates, licensors, and service
          providers, and its and their respective officers, directors, employees, contractors, agents, licensors,
          suppliers, successors, and assigns from and against any claims, liabilities, damages, judgments, awards,
          losses, costs, expenses, or fees (including reasonable attorneys&apos; fees) arising out of or relating to
          your violation of this Agreement or your use of the Software.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>12. Termination</LegalH2>
        <LegalH3>12.1 Termination by You</LegalH3>
        <LegalP>
          You may terminate this Agreement at any time by discontinuing your use of the Software and deleting all copies
          of the Software in your possession or control.
        </LegalP>
        <LegalH3>12.2 Termination by Us</LegalH3>
        <LegalP>
          We may terminate or suspend your access to the Software immediately, without prior notice or liability, for
          any reason whatsoever, including without limitation if you breach this Agreement.
        </LegalP>
        <LegalH3>12.3 Effect of Termination</LegalH3>
        <LegalP>
          Upon termination, your right to use the Software will immediately cease. You must immediately cease all use of
          the Software and delete all copies in your possession. All provisions of this Agreement which by their nature
          should survive termination shall survive, including ownership provisions, warranty disclaimers, indemnity, and
          limitations of liability.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>13. Export Compliance</LegalH2>
        <LegalP>
          The Software may be subject to export laws and regulations of the United States and other jurisdictions. You
          agree to comply with all applicable international and national laws that apply to the Software, including the
          U.S. Export Administration Regulations, as well as end-user, end-use, and destination restrictions.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>14. Governing Law and Jurisdiction</LegalH2>
        <LegalP>
          This Agreement shall be governed by and construed in accordance with the laws of the State of Delaware, United
          States, without regard to its conflict of law provisions.
        </LegalP>
        <LegalP>
          You agree to submit to the personal and exclusive jurisdiction of the courts located within the State of
          Delaware for the resolution of any disputes arising from or related to this Agreement.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>15. Dispute Resolution</LegalH2>
        <LegalH3>15.1 Arbitration</LegalH3>
        <LegalP>
          Any dispute, controversy, or claim arising out of or relating to this Agreement, including the breach,
          termination, or validity thereof, shall be finally resolved by binding arbitration in accordance with the
          Commercial Arbitration Rules of the American Arbitration Association.
        </LegalP>
        <LegalH3>15.2 Location and Language</LegalH3>
        <LegalP>
          The arbitration shall take place in the State of Delaware, United States, and shall be conducted in the
          English language.
        </LegalP>
        <LegalH3>15.3 Class Action Waiver</LegalH3>
        <LegalP>
          You agree that any arbitration or proceeding shall be limited to the dispute between the Company and you
          individually. You agree to waive any right to have any dispute heard as a class action, representative action,
          collective action, or private attorney general action.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>16. Miscellaneous</LegalH2>
        <LegalH3>16.1 Entire Agreement</LegalH3>
        <LegalP>
          This Agreement constitutes the entire agreement between you and Autonoma Inc. regarding the Software and
          supersedes all prior and contemporaneous agreements, proposals, or representations, written or oral,
          concerning its subject matter.
        </LegalP>
        <LegalH3>16.2 Severability</LegalH3>
        <LegalP>
          If any provision of this Agreement is found to be unenforceable or invalid, that provision shall be limited or
          eliminated to the minimum extent necessary so that this Agreement shall otherwise remain in full force and
          effect and enforceable.
        </LegalP>
        <LegalH3>16.3 Waiver</LegalH3>
        <LegalP>
          No waiver of any term of this Agreement shall be deemed a further or continuing waiver of such term or any
          other term, and the Company&apos;s failure to assert any right or provision under this Agreement shall not
          constitute a waiver of such right or provision.
        </LegalP>
        <LegalH3>16.4 Assignment</LegalH3>
        <LegalP>
          You may not assign or transfer this Agreement or any rights or obligations hereunder, by operation of law or
          otherwise, without the Company&apos;s prior written consent. The Company may assign this Agreement at any time
          without notice or consent.
        </LegalP>
        <LegalH3>16.5 Force Majeure</LegalH3>
        <LegalP>
          The Company shall not be liable for any failure or delay in performance under this Agreement due to
          circumstances beyond its reasonable control, including acts of God, war, terrorism, riots, embargoes, acts of
          civil or military authorities, fire, floods, accidents, strikes, or shortages of transportation, facilities,
          fuel, energy, labor, or materials.
        </LegalP>
      </LegalSection>

      <LegalSection>
        <LegalH2>17. Contact Information</LegalH2>
        <LegalP>
          If you have any questions about this EULA or need to contact us regarding the Software, please reach out to:
        </LegalP>
        <LegalUL>
          <li>
            <strong>Company:</strong> Autonoma Inc.
          </li>
          <li>
            <strong>Address:</strong> 251 Little Falls Drive, Wilmington, Delaware 19801, United States
          </li>
          <li>
            <strong>Email:</strong> support@autonoma.app
          </li>
        </LegalUL>
      </LegalSection>

      <LegalP>
        By installing or using Autonoma AI, you acknowledge that you have read this End User License Agreement and agree
        to be bound by its terms.
      </LegalP>
    </LegalPageLayout>
  );
}
