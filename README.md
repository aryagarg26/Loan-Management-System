# LoanDesk — Loan Management System

A responsive loan management demo built with **HTML, CSS, JavaScript, and JSON files**. Borrowers submit and track their own requests; bank managers review applications and update their status. It has no database and uses no third-party packages.

## Features

- Dashboard summary for applications, applications awaiting review, active loans, and estimated outstanding principal.
- Borrower and bank-manager sign-in with role-specific access.
- Borrowers submit loan requests and see only their own applications.
- Managers review applications, approve or reject them, and manage disbursement and simulated repayments.
- Search applications and filter by status.
- Move applications through the workflow: **Submitted → Under Review → Approved → Disbursed → Repaying → Closed**.
- Reject an application before disbursement.
- Calculate an estimated monthly EMI using the standard reducing-balance formula.
- Simulate an EMI payment and track the number of instalments recorded.
- Export the current records to a JSON download.
- Store loans and demo accounts in `data.json` when run with the included Node.js server. Passwords are stored as salted hashes; no database is used.
- Login sessions are held in server memory and expire after eight hours. Restarting the server signs users out.

## Run with JSON-file storage (recommended)

1. Install **Node.js** if it is not already installed. No extra npm packages are required.
2. Extract this ZIP and open the `loan-management-system` folder in Terminal / Command Prompt.
3. Run:

   ```bash
   node server.js
   ```

   Or run `npm start`.

4. Open **http://127.0.0.1:3000** in your browser.
5. Sign in with one of the demo accounts:

   | Role | Username | Password |
   |---|---|---|
   | Borrower | `borrower` | `borrower123` |
   | Bank manager | `manager` | `manager123` |

6. Submit requests as the borrower. Sign out and sign in as the manager to review them and update their status.
7. Stop the server with `Ctrl+C`.

If port 3000 is already being used, run `PORT=3001 node server.js` on macOS/Linux, then open `http://127.0.0.1:3001`. In Windows PowerShell use `$env:PORT=3001; node server.js`.

## Files

| File | Purpose |
|---|---|
| `index.html` | Single-page dashboard and application forms |
| `styles.css` | Responsive bank-style theme |
| `app.js` | Role-aware frontend, form validation, EMI logic, process steps, and API calls |
| `data.json` | Sample loan records, demo accounts, and persistent JSON data when using the server |
| `server.js` | Node.js HTTP server, in-memory demo sessions, and role-protected JSON API; no dependencies |
| `package.json` | Convenience `npm start` script |

## How the process works

1. **Application:** the signed-in borrower submits an amount, purpose, and tenure. The new record starts at `Submitted`.
2. **Review:** select `View details`, then choose `Start review`.
3. **Decision:** check the record, then choose `Approve application` or `Reject application`.
4. **Disbursement:** for an approved application, select `Disburse loan`.
5. **Repayment:** select `Start repayment tracking`, then use `Record next EMI` for each simulated payment. The loan moves to `Closed` after all scheduled instalments are recorded.

This demo records that an instalment has been marked as paid; it does **not** process money, validate identity, perform credit checks, calculate late fees, or send notifications. The included credentials and authentication are for local demonstration only, not production security.

## Replacing JSON with a database later

The frontend uses a small role-protected API:

- `POST /api/login`, `GET /api/session`, and `POST /api/logout` for demo sign-in.
- `GET /api/loans` returns all applications to a manager and only owned applications to a borrower.
- `POST /api/loans` creates a request for the signed-in borrower.
- `POST /api/loans/:id/action` lets a manager update the application workflow.

The JSON file remains the sole persistent store. For a production system, replace the demo authentication/session setup, and add audit history, backups, encryption, and proper repayment accounting before handling real customer information.

## Important notes

- All names and loan records included here are sample/demo data.
- EMI and outstanding principal are estimates for learning purposes, not official financial calculations or lending advice.
- `data.json` is plain text. Do not store actual customer data or expose this local server to the public internet.
