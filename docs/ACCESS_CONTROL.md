# Access control, user management and user deletion

## Access levels

Each user has an **access level** (`users.access_level`) and, separately, a **job role** (`users.role`, e.g. "Software Engineer").

| | Superadmin | Admin | User |
|---|---|---|---|
| Dashboard, Documents, Gallery, Chat, Profile, Published Newsletters | yes | yes | yes |
| View, preview and download documents and photos | all | all | what their role and per-document permissions allow |
| Upload, edit, move and delete documents, photos and folders | yes | yes | no |
| Administration (users list, add and edit users) | yes | yes | no |
| Email Campaigns | yes | yes | no |
| Grant or remove Admin | yes | yes | no |
| Change role permissions | yes | read only | no |
| Grant or remove Superadmin, edit a Superadmin | yes | no | no |
| Delete users | yes (never themselves or the last Superadmin) | no | no |

The rules live in one file: `src/config/accessPolicy.js`. The API checks them with `requireCapability(...)` on every route. The frontend receives the same capabilities with the profile and uses them for menus, routes and buttons. A page opened by URL shows "no access", and the API returns 403 for the request.

**Job-role permissions** (`role_permissions`: view, download) and **per-document permissions** (`document_permissions`) still decide which documents a regular user may open. A per-document entry wins over the role. A preview needs view permission. A download, or sharing a file in chat, needs download permission.

## Database changes (automatic on start: `src/config/rbacSchema.js`)

The migration only adds things and changes delete behaviour. Nothing is dropped.

- **`users.access_level`** (`superadmin` | `admin` | `user`, default `user`).
  - On the first start, existing administrators (`is_admin = true`) become Admin, and the default admin account (`DEFAULT_ADMIN_USERNAME`) becomes Superadmin.
  - `users.is_admin` is kept in step by a trigger, so older code keeps working.
- **A trigger refuses any change that would leave no Superadmin.**
- **The default administrator is now created only when no Superadmin exists.** Before, a deleted `admin` account came back with the default password on the next start.
- **`users.manager_id`** links a user to their manager.
  - It is filled once from the existing manager names, where a name matches exactly one user.
  - `users.manager` still holds the name.
- **Foreign keys to `users` now say what happens on delete:**
  - Uploaded documents and photos, conversations and calls: SET NULL (they are kept).
  - Chat membership, own messages and call participation: CASCADE.

## Deleting a user (`DELETE /api/auth/users/:id`, Superadmin)

Everything happens in one transaction: either it all happens or nothing does.

**Removed:**
- The account and refresh token
- Chat messages they sent, with their attachment files
- Chat memberships and call participation
- Favorites and download history
- Document sign-offs and per-document permissions
- Photo comments and hidden dashboard items
- Automation enrollments
- Their profile photo

**Kept:**
- Documents and photos they uploaded (the uploader shows as removed)
- Campaigns, templates and send history (the creator field is cleared)
- Other people's messages and conversations
- People who reported to them (the manager link is cleared)

A one-to-one chat with a deleted user becomes read-only for the other person. A group whose only admin was deleted gets its longest-standing member as admin.

Files are deleted only after the commit. A file that is still used elsewhere, such as a document shared in chat, is never deleted.

Their sessions end straight away:
- Every API call with their token returns 401 `ACCOUNT_REMOVED`, and the frontend signs them out.
- Their refresh token no longer exists.
- Their open chat connections are closed.

`GET /api/auth/users/:id/deletion-impact` returns what would be removed and kept. The confirmation dialog shows it.

## Users API

| Method | Path | Who |
|---|---|---|
| GET | `/auth/profile` | everyone: own profile with role, manager, access level, capabilities and permissions |
| GET | `/auth/users?search&accessLevel&status&sortBy&order&page&pageSize` | Admin, Superadmin: one page, total, summary counts |
| GET | `/auth/users/summary` | Admin, Superadmin |
| GET | `/auth/users/managers?search&exclude` | Admin, Superadmin: id, name, email and role only |
| GET / PATCH | `/auth/users/:id` | Admin, Superadmin (only a Superadmin may edit a Superadmin) |
| PATCH | `/auth/users/:id/access` `{ access_level }` | Admin (User ↔ Admin), Superadmin (all) |
| GET | `/auth/users/:id/deletion-impact` | Superadmin |
| DELETE | `/auth/users/:id` | Superadmin |

## Tests

```
RBAC_TEST=1 DB_HOST=… DB_DATABASE=adms_dev … npm run test:rbac
```

Run these against a development copy of the database, never production. The tests create and remove their own users and data.
