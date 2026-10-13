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
<p>Vireo is an open-source personal agent. You run its node on your own machine or server; the app at app.askvireo.com and the relay at cloud.askvireo.com let you reach that node. This policy covers those three parts and the Google integration.</p>

<h2>Where your data lives</h2>
<p>Your threads, memory, settings and connected-account tokens are stored on your own node, in its local database. We do not run your node and cannot read its database.</p>
<p>The cloud service at cloud.askvireo.com stores only what it needs to sign you in and reach your node: your GitHub user id, login, name and avatar URL; a hash of each session token; and for each node its name, a hash of its secret, how it connects, its version, its platform and when it was last seen. Requests the cloud relays to your node pass through it without being stored.</p>

<h2>Google user data</h2>
<p>When you connect Google, you choose which access to allow. Vireo asks for:</p>
<ul>
  <li>your email address (openid, email), to show which account is connected and to address mail you send;</li>
  <li>Google Calendar (calendar), to list, create, change and answer events when you ask;</li>
  <li>Gmail (gmail.modify), to search and read your mail, notice new mail in your inbox, and write drafts or send mail you confirm;</li>
  <li>Google Drive, read only (drive.readonly), to search and read files when you ask.</li>
</ul>
<p>Access and refresh tokens are stored on your node. When Vireo uses its shared Google client, cloud.askvireo.com forwards the sign-in result and token requests between Google and your node, because it holds that client's secret; it does not store the tokens or the data they unlock.</p>
<p>Google data is used only to do what you ask of Vireo. To answer you, your node sends the relevant part of it, such as an email you asked to have summarized, to the AI model provider you configured on your node. Tokens are never sent to a model. Vireo does not send email or change calendar events without your confirmation.</p>
<p>We do not sell Google user data, use it for advertising, or use it to train or improve AI or machine-learning models, and no one at Vireo reads it.</p>
<p>Vireo's use and transfer to any other app of information received from Google APIs will adhere to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

<h2>Third parties</h2>
<p>Your node talks to the services you connect: the AI model provider you choose, Google, Telegram, Feishu and others. Their own privacy policies apply to what they receive. The cloud service runs on Cloudflare and signs you in with GitHub.</p>

<h2>Deleting your data</h2>
<p>Disconnect Google in Settings → Plugins to delete its tokens from your node; you can also remove Vireo's access at <a href="https://myaccount.google.com/permissions">myaccount.google.com/permissions</a>. Removing a node in the app deletes its record from the cloud. To delete your cloud account, email ${mail}. Everything else is on your node, and you can delete it there.</p>

<h2>Changes and contact</h2>
<p>We will post changes to this page and update the date below. Questions: ${mail}.</p>
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
