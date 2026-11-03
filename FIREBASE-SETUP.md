# Connecting BuildSafe DIHS to Firebase

Until you finish these steps the app runs in **demo mode** (data is saved only in
the browser, no password needed). Once `firebase-config.js` is filled in, it
switches to Firebase automatically: real logins, and one shared database that
every teacher and the school head see live.

## 1. Create the project and copy its settings

1. Go to <https://console.firebase.google.com> → **Add project**.
2. **Project settings → General → Your apps → Web (`</>`)** → register an app.
3. Copy the `firebaseConfig` values into **`firebase-config.js`**
   (`apiKey`, `authDomain`, `projectId`, `storageBucket`, `messagingSenderId`, `appId`).

## 2. Turn on login

**Build → Authentication → Get started → Sign-in method → Email/Password → Enable.**

## 3. Create the database and publish the rules

1. **Build → Firestore Database → Create database** (production mode, any region).
2. Open the **Rules** tab, paste the contents of **`firestore.rules`**, and **Publish**.

(With the Firebase CLI instead: `firebase use --add` then `firebase deploy --only firestore:rules`.)

## 4. Create the accounts

For each person:

1. **Authentication → Users → Add user.**
   Email = their account number + `@dihs.buildsafe` (for example `1001@dihs.buildsafe`),
   plus a password. On the login page they type just `1001`.
   (Typing a full email address also works.)
2. Copy the new user's **User UID**.
3. **Firestore Database → Data → Start collection** `users` (first time only), then add a
   document whose **Document ID is that UID** with these fields:

   | field         | type   | value                              |
   |---------------|--------|------------------------------------|
   | `role`        | string | `schoolHead` **or** `teacher`      |
   | `displayName` | string | e.g. `Mrs. Santos`                 |

A login with no `users/{uid}` document is refused, and the login card must match the
role (a teacher can't sign in on the School Head card).

## 5. Run it

* Firebase login needs the app to be served over **http(s)**, not opened by
  double-clicking the file. Locally: `python3 -m http.server 8000` in this folder,
  then open <http://localhost:8000>.
* **GitHub Pages:** add your Pages domain (for example `yourname.github.io`) under
  **Authentication → Settings → Authorized domains**.
* **Firebase Hosting (optional):** `firebase deploy --only hosting` (uses `firebase.json`).

The three starting rooms (18, 19, 20) are created in the database automatically the
first time someone signs in. More classrooms are added from the app (see
"Adding classrooms and reports" below). To rename an adviser, edit the room's
`adviser` field in Firestore (`rooms/18`, …).

## What is stored where

| Collection         | Contents                                                                    |
|--------------------|-----------------------------------------------------------------------------|
| `users/{uid}`      | `role`, `displayName` — created by you, never by the app                    |
| `rooms/{number}`   | room name, building, adviser, photo, `items[]` (item, quantity, damage)     |
| `reports/{id}`     | one defect report, its verification, maintenance status, and status history |

Photos are shrunk in the browser and stored inside the documents, so no paid
Cloud Storage plan is needed.

## Who can do what (enforced by `firestore.rules`)

| Action                                  | Teacher | School Head |
|-----------------------------------------|:-------:|:-----------:|
| Read rooms and reports                  |   yes   |     yes     |
| Add a classroom                         |   yes   |     yes     |
| Edit inventory and room photo           |   yes   |     yes     |
| Submit a defect report                  |   yes   |     no      |
| Verify a report / set maintenance status|   no    |     yes     |
| Delete anything                         |   no    |     no      |

## Good to know

* Data saved in demo mode (on someone's computer) is **not** uploaded to Firebase.
* Every teacher can see every room. If you later want teachers limited to their own
  room, store a `rooms` list on `users/{uid}` and tighten the rules.
* The Firebase SDK is loaded from Google's CDN (version pinned in `store.js`), so
  the pages need internet access.

## Adding classrooms and reports

### In the app

* **Add a classroom** (teacher or school head): on the dashboard, click
  **+ Add Classroom**, enter the room number, building and (optionally) the adviser.
  The room gets a standard item list at quantity 0. Open it and set the real
  quantities with **Update Inventory**.
* **Add a report** (teacher only): on the teacher dashboard click
  **+ Report a Problem**, pick the classroom and item, then fill in the concern.
  Reports start as *Pending Verification*; the school head verifies them on the
  Reports page.

### What you must do in Firebase

1. **Publish the updated rules** (one time). Adding classrooms needs the new
   `rooms` rule in `firestore.rules`. In the VS Code terminal run:

   ```
   firebase deploy --only firestore:rules
   ```

   (Or: Firestore Database → Rules → paste `firestore.rules` → Publish.)

2. **Nothing else.** You do not create rooms or reports by hand: the app writes them.
   Authentication, the `users` collection and the indexes stay as they are.

### What the app saves (so you can recognise it in the console)

`rooms/{number}` — the document ID is the room number, for example `21`.

| field       | type      | example                                              |
|-------------|-----------|------------------------------------------------------|
| `room`      | string    | `Room 21`                                            |
| `building`  | string    | `Building 5`                                         |
| `adviser`   | string    | `Ms. Cruz` (can be empty)                            |
| `photo`     | string    | empty until a photo is uploaded                      |
| `items`     | array     | list of maps: `item` (string), `quantity` (number), `damage` (string) |
| `updatedAt` | string    | set by the app                                       |
| `updatedBy` | string    | the creator's UID                                    |

`reports/{auto id}` — one per defect report.

| field             | type    | example                                    |
|-------------------|---------|--------------------------------------------|
| `roomNumber`      | string  | `21`                                       |
| `room`            | string  | `Room 21`                                  |
| `item`            | string  | `Windows`                                  |
| `quantity`        | number  | `2`                                        |
| `itemDetail`      | string  | `Ceiling fan` (type, position or location of the item) |
| `concern`         | string  | `Broken`                                   |
| `defectKind`      | string  | `Broken arm rest`, `Unstable`, `Missing leg`, … |
| `action`          | string  | `For repair` or `For disposal`             |
| `description`     | string  | `Two panes cracked`                        |
| `photo`           | string  | empty or a compressed image                |
| `dateReported`    | string  | ISO date set by the app                    |
| `verification`    | string  | `Pending Verification` (becomes `Verified`) |
| `status`          | string  | empty (becomes Scheduled / In Progress / Completed) |
| `createdBy`       | string  | the teacher's UID                          |
| `createdByName`   | string  | the teacher's display name (shown on the room's report list) |
| `statusHistory`   | array   | list of status and date entries            |

To add a classroom by hand instead, go to Firestore Database → Data → `rooms` →
Add document, use the room number as the Document ID, and add the fields above
(`items` must contain at least one map).

### Report options (item type, defect, repair or disposal)

When a teacher files a report, the form now asks, depending on the item:

| Item               | Asks for                                   | Example defects                              |
|--------------------|--------------------------------------------|----------------------------------------------|
| Armchairs          | type of chair (armchair or other)          | broken arm rest, unstable, missing leg       |
| Tables             | type of table                              | unstable, broken leg, cracked top            |
| Door               | which door                                 | broken lock, broken hinge                    |
| Windows            | position (front facing the hallway, back)  | broken glass, cannot open or close           |
| Lights             | ceiling or wall                            | not working, flickering                      |
| Electrical Outlets | location (front, back, left, right wall)   | no power, loose, exposed wires               |
| Electric Fans      | ceiling, wall or stand fan                 | not working, noisy, wobbling                 |
| Other              | what the item is (typed)                   | damaged, broken, missing                     |

Every list has an **Other** choice that opens a box to type the detail. The teacher must
also choose **For repair** or **For disposal**. The School Head sees these on the report.

**Firebase step:** publish the updated rules once, so the new fields are checked:

```
firebase deploy --only firestore:rules
```

Nothing else changes in Firebase. Reports filed before this update simply show "—" for the new fields.

### Report history per room (School Head)

On the **Reports** page the classroom list stays. Click a room to open **all** reports
filed for that room, newest first. Old reports are never replaced: when a teacher adds a
new report, the earlier ones stay in the list as history.

* The room page shows Total, Pending Review, In Progress and Completed counts, a search
  box, and filter buttons (All, Pending, Verified, In Progress, Completed).
* **View Details** opens that one report. **Back to Room Reports** returns to the list.
* Stages: *Pending* = not yet verified, *Verified* = verified and waiting or scheduled,
  *In Progress*, *Completed*.

**Firebase step:** publish the rules once so the new `createdByName` field is checked:

```
firebase deploy --only firestore:rules
```

Reports filed before this update have no teacher name saved, so the list shows the room's
adviser name instead.
