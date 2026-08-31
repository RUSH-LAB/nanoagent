# Local site optimization — first milestone

Status: completed.

Production deployment was paused while the local development workflow and
initial JavaScript cost were improved.

Completed results:

- `npm start`, `npm run start:postgres`, and `npm run start:noauth` supervise
  the API and Docusaurus process together and leave no orphan process on exit.
- Startup validates ports and PostgreSQL configuration before spawning either
  service.
- Local search and safe plugin MDX clients load outside the initial bundle.
- The uncompressed initial application bundle fell from 546,307 bytes to
  512,910 bytes; gzip size fell from about 172.7 KB to 161.6 KB.
- The authenticated production build and all 2,614 unit tests passed.

The remaining product work moved to the
[workspace content and rendering plan](../workspace-content-and-rendering.md).
