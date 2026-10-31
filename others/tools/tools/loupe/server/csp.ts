// The content security policy of the app (design 9). One definition: vite.config.ts writes it into index.html as a meta tag and
// `loupe serve` sends it as a header. The header is what reaches the Markdown worker, which parses all the hostile text and does not
// inherit the document's meta tag. A static server without the header leaves the worker uncovered.
export const APP_CSP = [
  "default-src 'none'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "font-src 'self'",
  "connect-src 'self'", "worker-src 'self'", "base-uri 'none'", "form-action 'none'",
].join('; ');
/** Header form: `frame-ancestors` cannot be set by a meta tag. */
export const APP_CSP_HEADER = `${APP_CSP}; frame-ancestors 'none'`;
/** /kb/* responses are captured pages: nothing may run, whatever the document is. */
export const KB_CSP_HEADER = "default-src 'none'; sandbox; frame-ancestors 'none'";
