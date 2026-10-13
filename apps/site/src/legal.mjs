/**
 * The privacy policy and terms of service, in English: Google's OAuth
 * consent screen links to them, and its reviewers read English. Each is
 * plain HTML for the doc template in page.mjs.
 */

export const CONTACT = "lisongjianshuai@gmail.com";
export const UPDATED = "October 13, 2026";

const mail = `<a href="mailto:${CONTACT}">${CONTACT}</a>`;

export const privacy = {
  path: "/privacy/",
  title: "Privacy Policy",
  body: `
<p>Vireo is an open-source personal agent. Each person runs a <strong>node</strong>: the Vireo software on their own machine or server, holding their threads, memory, files and connected accounts. Vireo also runs two hosted pieces, the app at app.askvireo.com and the cloud service at cloud.askvireo.com, which signs you in and connects the app to your node.</p>
<p>This policy explains what the hosted pieces and the software's Google integration collect, why, where it is kept and how to remove it. It does not cover a node you run yourself, or the services you choose to connect to it; those are yours and follow their own policies. Application name: <strong>Vireo</strong>. Contact: ${mail}.</p>

<h2>Information we collect</h2>
<p><strong>Sign-in information.</strong> You sign in to the hosted app with GitHub. We receive your GitHub user id, login, display name and avatar URL. We never receive your GitHub password.</p>
<p><strong>Session and node records.</strong> The cloud service keeps a hash of each session token it issues. For each node you link it keeps the node's id, its owner, its name, a hash of its secret, how it connects (through the relay, or a direct address such as a Tailscale name), and the version, platform and last-seen time the node reports.</p>
<p><strong>Relayed requests.</strong> While a node is reachable only through the relay, the requests the app makes to it pass through the cloud service. They are forwarded and are not stored or read.</p>
<p><strong>Sign-in state.</strong> While a Google sign-in is under way on Vireo's shared OAuth client, the cloud service keeps the random state value, the node that started the sign-in and the node's callback address, for up to 30 minutes, so Google's answer reaches the right node. It is deleted when the sign-in finishes, is redeemed once, or expires. The same holds for the temporary records of a node that is being linked.</p>
<p><strong>Content on your node.</strong> Your threads and messages, your memory, your plugin settings, uploaded files, the browser profile, audit records and the tokens of the accounts you connect are stored on your node, not on our servers. We do not host your node and cannot read its database.</p>

<h2>Google user data</h2>
<p>You connect Google from the Google plugin inside Vireo and choose which access to grant. Vireo asks for four, and uses each only for what is written beside it:</p>
<ul>
  <li><strong>Your email address</strong> (<code>openid</code>, <code>email</code>): to show which account is connected, and to address email you send.</li>
  <li><strong>Google Calendar</strong> (<code>https://www.googleapis.com/auth/calendar</code>): to list, create, change and answer events when you ask.</li>
  <li><strong>Gmail</strong> (<code>https://www.googleapis.com/auth/gmail.modify</code>): to search and read your mail, to notice new mail in your inbox, and to write drafts or send mail that you confirm.</li>
  <li><strong>Google Drive, read only</strong> (<code>https://www.googleapis.com/auth/drive.readonly</code>): to search and read files when you ask.</li>
</ul>
<p>Vireo uses Google user data only to do what you ask of it. It never sends mail, creates, changes or deletes events, or writes to Drive without your confirmation. It does not read your mail or files in the background beyond the inbox and calendar checks, which you can turn off in Settings.</p>
<p><strong>Where Google data is kept.</strong> Access and refresh tokens are stored on your node. Events, messages and files are fetched when needed and kept in the thread they belong to, on your node; they are not copied to our servers. When the Google plugin uses Vireo's shared OAuth client, the cloud service forwards the sign-in result and the token requests between Google and your node, because it holds that client's secret. It does not store those tokens, or the Google data they unlock.</p>
<p><strong>Sharing with the AI model.</strong> To answer you, your node sends the relevant part of your Google data, such as an email you asked to have summarized, to the AI model provider you configured on your node. Tokens are never sent to a model. Which provider that is, and where it processes data, is your choice, and its own policy applies to what it receives.</p>
<p><strong>No sale, no advertising, no training.</strong> We do not sell Google user data, do not use it for advertising or to build advertising profiles, and do not use it to train or improve AI or machine-learning models. We do not use it to determine creditworthiness or for lending, and no one at Vireo reads it.</p>
<p><strong>Limited Use.</strong> Vireo's use and transfer to any other app of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

<h2>How we use information</h2>
<p>We use the information above to sign you in, to connect the app to your node and let your nodes reach each other, to keep the service working and secure, and to answer you when you write to us. We do not use it for advertising, and we do not combine it with data from other sources for advertising or profiling.</p>

<h2>How we share information</h2>
<p>We share data only as needed to run Vireo: with Cloudflare, which hosts the website and the cloud service; with GitHub, for sign-in; with Google, when you connect it; and, on your node, with the AI model provider and any other service you connect. We do not sell personal data. We may disclose information when the law requires it, and we will tell you unless we are legally barred from doing so.</p>

<h2>How long we keep it</h2>
<p>Account and node records stay until you remove the node, delete your account, or ask us to delete them. Pending Google sign-in states expire within 30 minutes, and a state can be redeemed only once. Session tokens expire and are replaced at each sign-in. Everything on your node stays until you delete it: it is under your control, and deleting the node's data directory removes it.</p>

<h2>Security</h2>
<p>Traffic to the hosted pieces is encrypted with HTTPS. Node secrets and session tokens are kept only as hashes. On your node, website passwords are kept in an encrypted vault whose key stays in the node's data directory, and the model never sees them. No method is perfectly secure, so keep your node's machine, its data directory and your account sign-in protected.</p>

<h2>Your choices and rights</h2>
<p>You can disconnect Google at any time under Settings → Plugins, which deletes its tokens from your node, and you can also remove Vireo's access at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. You can remove a node in the app, which deletes its record from the cloud service. You can delete threads, memory, files and anything else on your node there. To delete your cloud account, or to ask what we hold about you, correct it, or get a copy, email ${mail}; we answer within 30 days. Depending on where you live you may have further rights under the GDPR, the CCPA or similar laws, and we honour requests made under them.</p>

<h2>Children</h2>
<p>Vireo is not directed to children under 13, and we do not knowingly collect their data.</p>

<h2>Where data is processed</h2>
<p>Our hosting and the AI providers you choose may process data in countries other than yours. Where the law requires it, such transfers rely on appropriate safeguards, such as standard contractual clauses.</p>

<h2>Changes and contact</h2>
<p>We will post changes to this page and update the date below, and material changes will be noted on the website. Questions about this policy, or about your data: ${mail}.</p>
`,
};

export const terms = {
  path: "/terms/",
  title: "Terms of Service",
  body: `
<p>These terms cover the Vireo app at app.askvireo.com and the cloud service at cloud.askvireo.com. The Vireo software is open source under the MIT License, which governs your use of the code.</p>

<h2>Your use</h2>
<p>You may use Vireo for any lawful purpose. You are responsible for your node, for the accounts and AI model provider you connect to it, and for what Vireo does on your behalf after you confirm it. Do not use the cloud service to attack, overload or get unauthorized access to any system, or to relay content that is illegal.</p>

<h2>Connected accounts</h2>
<p>When you connect a service such as Google, you allow Vireo to act on that account as described in the <a href="/privacy/">Privacy Policy</a>. You can disconnect at any time. Your use of those services remains subject to their own terms.</p>

<h2>The service</h2>
<p>The app and the cloud service are provided free of charge, "as is", without warranty of any kind. We may change, suspend or end them, and may suspend accounts that break these terms. An AI agent can make mistakes; check what it prepares before you confirm it.</p>

<h2>Liability</h2>
<p>To the extent the law allows, we are not liable for indirect, incidental or consequential damages, or for loss of data, arising from your use of Vireo.</p>

<h2>Changes and contact</h2>
<p>We will post changes to this page and update the date below. Questions: ${mail}.</p>
`,
};

export const legal = { updated: UPDATED, docs: [privacy, terms] };
