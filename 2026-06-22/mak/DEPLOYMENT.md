# Publish CHS Courts at chelmsfordcourts.com

## 0. Register the domain

Creating a Cloudflare DNS zone or choosing Cloudflare's free plan does not register a `.com` name. If `chelmsfordcourts.com` is still available, open **Domain Registration → Register Domains** in Cloudflare, search for it, purchase a registration term, and verify the registrant email. The Pages hosting can stay on the free plan, but `.com` registration has an annual registry/ICANN cost.

## 1. Deploy the updated project

1. Open Cloudflare **Workers & Pages** and select the `chelmsfordcourts` Pages project.
2. Choose **Create deployment** and upload the ZIP named `UPLOAD-THIS-TO-CLOUDFLARE.zip` (or `CHS-Courts-Fixed-Upload.zip`). Do not upload the outer all-in-one ZIP.
3. Confirm the production deployment finishes successfully.
4. In **Settings → Bindings**, confirm the D1 database binding is named exactly `DB`.
5. In **Settings → Variables and secrets**, keep the production admin variables configured.

## 2. Attach the custom domain

1. In the Pages project, open **Custom domains**.
2. Add `chelmsfordcourts.com` and then `www.chelmsfordcourts.com`.
3. If Cloudflare manages the domain DNS, allow Pages to create the required DNS records.
4. Set one hostname as canonical and redirect the other to it. This project uses `https://chelmsfordcourts.com/` as canonical.
5. Wait until both custom domains show **Active**, then verify HTTPS works.

## 3. Make the site discoverable

The package includes:

- a descriptive page title and description;
- a canonical link for `https://chelmsfordcourts.com/`;
- `robots.txt` that allows the public site and excludes private/API routes;
- `sitemap.xml` for the public homepage.

## 4. Ask Google to index it

1. Open Google Search Console and add the **Domain** property `chelmsfordcourts.com`.
2. Copy the Google TXT verification record into Cloudflare DNS and finish verification.
3. In Search Console, submit `https://chelmsfordcourts.com/sitemap.xml` under **Sitemaps**.
4. Use **URL Inspection** for `https://chelmsfordcourts.com/`, run the live test, and choose **Request indexing**.
5. Keep the homepage publicly accessible. Google controls when and where it appears; indexing is not instant or guaranteed.

## 5. Production smoke test

- Open the `.com` address in a private window and make a test booking.
- Open it on a second device and confirm the booking is shared.
- Mark a court down from one browser, confirm it appears in another, then report it open again.
- In the Admin Portal, confirm the current status and recent status log appear and that an admin override works.
- Submit a priority hold and confirm it appears immediately.
- Sign in to the Admin Portal and confirm the public blocks appear there.
- Confirm `https://chelmsfordcourts.com/robots.txt` and `/sitemap.xml` load.

## Admin Portal troubleshooting

- Use the stable project address, `https://chelmsfordcourts.pages.dev/`, rather than an old deployment-specific address containing a random prefix.
- `https://chelmsfordcourts.pages.dev/api/health` must display JSON in the browser. If it downloads a file or returns a normal webpage, the wrong ZIP was deployed.
- `https://chelmsfordcourts.pages.dev/admin-login` must open the sign-in screen without redirecting.
- The production ZIP keeps `_worker.js`, `_headers`, and every HTML/JS asset at the ZIP root. Uploading the outer source package or the containing folder can prevent the login API from running.
