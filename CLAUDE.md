# Notes for Claude

- Production deployment (EC2 host, CI/CD, secrets, ops, troubleshooting) is documented in
  `DEPLOYMENT.md`. Read it before any deploy, server, or infra work, and keep it updated when
  the setup changes.
- This repo is public and tracks only server-side code (`backend/`, `mosquitto/`, compose files,
  workflow). `app/`, `firmware/`, etc. exist locally but are gitignored on purpose.
- Pushing to `main` deploys to production. Server SSH:
  `ssh -i ~/Documents/home_security_new ubuntu@13.206.228.27`.
- Auto mode blocks Claude from writing GitHub secrets (`gh secret set`), editing remote
  `authorized_keys`, and adding boot-time entries (e.g. fstab swap) on the server; hand those commands to the user.
