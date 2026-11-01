/* =========================================================
   BUILDSAFE DIHS — DATA STORE

   One interface, two backends:

     cloud  Firebase Authentication + Cloud Firestore.
            Used when firebase-config.js has been filled in.

     local  This browser's localStorage (demo mode).
            Used while Firebase is not configured, so the
            app keeps working exactly as before.

   app.js only talks to BuildSafeStore and never needs to
   know which backend is running.
========================================================= */

(function (root, factory) {

    const api = factory();

    if (typeof module === "object" && module.exports) {

        module.exports = api;

    } else {

        root.BuildSafe = api;

        root.BuildSafeStore = api.createStore({
            config: root.BUILDSAFE_FIREBASE_CONFIG
        });

    }

})(typeof window !== "undefined" ? window : globalThis, function () {

    "use strict";


    /* =====================================================
       CONSTANTS
    ===================================================== */

    const FIREBASE_SDK_VERSION = "12.11.0";

    const FIREBASE_SDK_URL =
        "https://www.gstatic.com/firebasejs/" +
        FIREBASE_SDK_VERSION +
        "/";

    const ROLES = {
        HEAD: "schoolHead",
        TEACHER: "teacher"
    };

    const ROLE_LABELS = {
        schoolHead: "School Head",
        teacher: "Teacher / Room Adviser"
    };

    const MAINTENANCE_STATUSES = [
        "Scheduled",
        "In Progress",
        "Completed"
    ];

    // Accounts are Firebase email/password users. A bare account number
    // such as "1001" is signed in as "1001@dihs.buildsafe".
    const ACCOUNT_EMAIL_DOMAIN = "dihs.buildsafe";

    // Photos are stored inside Firestore documents (1 MiB limit),
    // so they are compressed before saving.
    const MAX_PHOTO_CHARS = 600000;

    const WRITE_TIMEOUT_MS = 6000;


    /* =====================================================
       DEFAULT ROOMS (first-run data)
    ===================================================== */

    const DEFAULT_ROOMS = {

        "18": {
            room: "Room 18",
            building: "Building 17",
            adviser: "Teacher A",
            photo: "https://images.unsplash.com/photo-1588072432836-e10032774350?auto=format&fit=crop&w=1000&q=80",
            items: [
                { item: "Armchairs", quantity: 40, damage: "2" },
                { item: "Tables", quantity: 20, damage: "None" },
                { item: "Door", quantity: 2, damage: "1" },
                { item: "Windows", quantity: 8, damage: "2" },
                { item: "Lights", quantity: 6, damage: "1" },
                { item: "Electrical Outlets", quantity: 4, damage: "1" },
                { item: "Electric Fans", quantity: 5, damage: "1" }
            ]
        },

        "19": {
            room: "Room 19",
            building: "Building 17",
            adviser: "Teacher B",
            photo: "https://images.unsplash.com/photo-1562774053-701939374585?auto=format&fit=crop&w=1000&q=80",
            items: [
                { item: "Armchairs", quantity: 30, damage: "1 broken" },
                { item: "Tables", quantity: 5, damage: "None" },
                { item: "Door", quantity: 1, damage: "None" },
                { item: "Windows", quantity: 8, damage: "None" },
                { item: "Lights", quantity: 6, damage: "None" },
                { item: "Electrical Outlets", quantity: 4, damage: "None" },
                { item: "Electric Fans", quantity: 4, damage: "None" }
            ]
        },

        "20": {
            room: "Room 20",
            building: "Building 17",
            adviser: "Teacher C",
            photo: "https://images.unsplash.com/photo-1503676260728-1c00da094a0b?auto=format&fit=crop&w=1000&q=80",
            items: [
                { item: "Armchairs", quantity: 30, damage: "None" },
                { item: "Tables", quantity: 5, damage: "None" },
                { item: "Door", quantity: 1, damage: "None" },
                { item: "Windows", quantity: 8, damage: "1 cracked pane" },
                { item: "Lights", quantity: 6, damage: "None" },
                { item: "Electrical Outlets", quantity: 4, damage: "None" },
                { item: "Electric Fans", quantity: 4, damage: "1 not working" }
            ]
        }

    };


    /* =====================================================
       ERRORS
       StoreError messages are written for end users and are
       shown as-is. Anything else gets a generic message.
    ===================================================== */

    class StoreError extends Error {

        constructor(code, message) {

            super(message);

            this.name = "StoreError";
            this.code = code;
            this.isStoreError = true;

        }

    }


    /* =====================================================
       SMALL HELPERS
    ===================================================== */

    function nowIso() {
        return new Date().toISOString();
    }

    function clone(value) {
        return JSON.parse(JSON.stringify(value));
    }

    function sameText(a, b) {

        return String(a == null ? "" : a).trim().toLowerCase() ===
            String(b == null ? "" : b).trim().toLowerCase();

    }

    function generateId() {

        return Date.now().toString(36) +
            Math.random().toString(36).slice(2, 8);

    }

    function memoryStorage() {

        const data = new Map();

        return {
            getItem: function (key) {
                return data.has(key) ? data.get(key) : null;
            },
            setItem: function (key, value) {
                data.set(key, String(value));
            },
            removeItem: function (key) {
                data.delete(key);
            }
        };

    }

    function safeStorage(kind) {

        try {

            const storage = window[kind];
            const probe = "__buildsafe_probe__";

            storage.setItem(probe, "1");
            storage.removeItem(probe);

            return storage;

        } catch (error) {

            return memoryStorage();

        }

    }

    function isConfigured(config) {

        return Boolean(
            config &&
            typeof config.apiKey === "string" && config.apiKey.trim() &&
            typeof config.projectId === "string" && config.projectId.trim()
        );

    }

    function accountToEmail(account) {

        const value = String(account || "").trim().toLowerCase().replace(/\s+/g, "");

        return value.includes("@")
            ? value
            : value + "@" + ACCOUNT_EMAIL_DOMAIN;

    }


    /* =====================================================
       NORMALIZERS
       Every record is passed through these on the way out of
       a backend, so older saved data and new data look alike.
    ===================================================== */

    function normalizeItems(items) {

        if (!Array.isArray(items)) return [];

        return items
            .filter(function (entry) {
                return entry && String(entry.item || "").trim();
            })
            .map(function (entry) {

                const quantity = Number(entry.quantity);

                return {
                    item: String(entry.item).trim(),
                    quantity: Number.isFinite(quantity) && quantity >= 0
                        ? Math.floor(quantity)
                        : 0,
                    damage: String(
                        entry.damage == null || entry.damage === ""
                            ? "None"
                            : entry.damage
                    ).trim() || "None"
                };

            });

    }

    function normalizeRoom(roomNumber, raw) {

        const base = DEFAULT_ROOMS[roomNumber] || {};
        const data = raw && typeof raw === "object" ? raw : {};

        return {
            roomNumber: String(roomNumber),
            room: data.room || base.room || "Room " + roomNumber,
            building: data.building || base.building || "Building 17",
            adviser: data.adviser || base.adviser || "",
            photo: data.photo || base.photo || "",
            items: Array.isArray(data.items)
                ? normalizeItems(data.items)
                : clone(base.items || [])
        };

    }

    function roomNumberOf(raw) {

        const candidates = [
            raw.roomNumber,
            raw.room,
            raw.classroom,
            raw.roomId
        ];

        for (let i = 0; i < candidates.length; i++) {

            const value = candidates[i];

            if (value === undefined || value === null) continue;

            const match = String(value).match(/\d+/);

            if (match) return match[0];

        }

        return "";

    }

    function normalizeReport(raw, fallbackId) {

        const data = raw && typeof raw === "object" ? raw : {};
        const roomNumber = roomNumberOf(data);

        const history = Array.isArray(data.statusHistory)
            ? data.statusHistory
                .filter(function (entry) {
                    return entry && entry.status;
                })
                .map(function (entry) {

                    // Older versions saved a "Select Status" placeholder
                    // when a report was verified.
                    return {
                        status: entry.status === "Select Status"
                            ? "Report Verified"
                            : String(entry.status),
                        date: entry.date || ""
                    };

                })
            : [];

        return {
            id: String(data.id || fallbackId || ""),
            roomNumber: roomNumber,
            room: data.room && /\D/.test(String(data.room))
                ? String(data.room)
                : "Room " + roomNumber,
            item: String(data.item || ""),
            itemDetail: String(data.itemDetail || ""),
            quantity: Number(data.quantity) || 0,
            concern: String(data.concern || ""),
            defectKind: String(data.defectKind || ""),
            action: REPORT_ACTIONS.indexOf(data.action) === -1 ? "" : data.action,
            description: String(data.description || ""),
            photo: String(data.photo || ""),
            dateReported: data.dateReported || "",
            verification: data.verification === "Verified"
                ? "Verified"
                : "Pending Verification",
            verifiedDate: data.verifiedDate || "",
            verifiedBy: data.verifiedBy || "",
            status: data.status && data.status !== "Select Status"
                ? String(data.status)
                : "",
            actualCompletion: data.actualCompletion || "",
            damageResolved: Boolean(data.damageResolved),
            statusHistory: history,
            createdBy: data.createdBy || ""
        };

    }


    /* =====================================================
       DAMAGE COUNTS
       Damage is free text ("2", "None", "1 cracked pane").
       Only the leading number takes part in arithmetic.
    ===================================================== */

    function parseDamage(value) {

        const match = String(value == null ? "" : value).match(/\d+/);

        return match ? parseInt(match[0], 10) : 0;

    }

    function formatDamage(count) {

        return count > 0 ? String(count) : "None";

    }

    function findItem(items, name) {

        return items.find(function (entry) {
            return sameText(entry.item, name);
        });

    }


    /* =====================================================
       BUSINESS RULES
       Pure functions: they read a report and its room and
       return what should change. Both backends apply the
       result the same way, so behaviour is identical.
    ===================================================== */

    const REPORT_ACTIONS = ["For repair", "For disposal"];

    function buildNewReport(input, now, uid) {

        const roomNumber = String(input.roomNumber || "").replace(/\D/g, "");
        const item = String(input.item || "").trim();
        const concern = String(input.concern || "").trim();
        const description = String(input.description || "").trim();
        const itemDetail = String(input.itemDetail || "").trim();
        const defectKind = String(input.defectKind || "").trim();
        const action = String(input.action || "").trim();
        const quantity = Number(input.quantity);
        const photo =
            typeof input.photo === "string" &&
            input.photo.indexOf("data:image/") === 0
                ? input.photo
                : "";

        if (!roomNumber || !item || !concern || !description) {

            throw new StoreError(
                "invalid-report",
                "Please complete the required report information."
            );

        }

        if (!Number.isInteger(quantity) || quantity < 1) {

            throw new StoreError(
                "invalid-report",
                "Quantity must be a whole number of 1 or more."
            );

        }

        if (description.length > 2000) {

            throw new StoreError(
                "invalid-report",
                "Please keep the description under 2000 characters."
            );

        }

        if (itemDetail.length > 100 || defectKind.length > 100) {

            throw new StoreError(
                "invalid-report",
                "Please keep the item detail and defect under 100 characters."
            );

        }

        if (REPORT_ACTIONS.indexOf(action) === -1) {

            throw new StoreError(
                "invalid-report",
                "Please choose whether the item is for repair or for disposal."
            );

        }

        if (photo.length > MAX_PHOTO_CHARS) {

            throw new StoreError(
                "photo-too-large",
                "That photo is too large. Please choose a smaller one."
            );

        }

        return {
            id: generateId(),
            roomNumber: roomNumber,
            room: "Room " + roomNumber,
            item: item,
            itemDetail: itemDetail,
            quantity: quantity,
            concern: concern,
            defectKind: defectKind,
            action: action,
            description: description,
            photo: photo,
            dateReported: now,
            verification: "Pending Verification",
            verifiedDate: "",
            verifiedBy: "",
            status: "",
            actualCompletion: "",
            damageResolved: false,
            statusHistory: [{ status: "Report Submitted", date: now }],
            createdBy: uid || ""
        };

    }

    // Every new classroom starts with the same checklist of items (quantity 0)
    // so that defect reports can name an item right away. Edit the quantities
    // on the room's inventory page.
    const STARTER_ITEMS = [
        "Armchairs",
        "Tables",
        "Door",
        "Windows",
        "Lights",
        "Electrical Outlets",
        "Electric Fans"
    ];

    function buildNewRoom(input) {

        const roomNumber = String(input.roomNumber || "").trim();
        const building = String(input.building || "").trim();
        const adviser = String(input.adviser || "").trim();

        if (!/^\d{1,4}$/.test(roomNumber)) {

            throw new StoreError(
                "invalid-room",
                "Room number must be 1 to 4 digits, for example 21."
            );

        }

        if (!building) {

            throw new StoreError(
                "invalid-room",
                "Please enter the building, for example Building 17."
            );

        }

        if (building.length > 60 || adviser.length > 80) {

            throw new StoreError(
                "invalid-room",
                "The building or adviser name is too long."
            );

        }

        return {
            roomNumber: roomNumber,
            room: "Room " + roomNumber,
            building: building,
            adviser: adviser,
            photo: "",
            items: STARTER_ITEMS.map(function (name) {
                return { item: name, quantity: 0, damage: "None" };
            })
        };

    }

    function planVerification(report, room, now, verifiedBy) {

        if (report.verification === "Verified") {

            throw new StoreError(
                "already-verified",
                "This report is already verified."
            );

        }

        // Verified defects are added to the room's damage count.
        const items = clone(room.items);
        const entry = findItem(items, report.item);

        if (entry) {

            entry.damage = formatDamage(
                parseDamage(entry.damage) + report.quantity
            );

        }

        return {
            reportPatch: {
                verification: "Verified",
                verifiedDate: now,
                verifiedBy: verifiedBy || "",
                statusHistory: report.statusHistory.concat({
                    status: "Report Verified",
                    date: now
                })
            },
            roomItems: entry ? items : null
        };

    }

    function planStatusChange(report, room, newStatus, now) {

        if (MAINTENANCE_STATUSES.indexOf(newStatus) === -1) {

            throw new StoreError(
                "invalid-status",
                "Invalid maintenance status."
            );

        }

        if (report.verification !== "Verified") {

            throw new StoreError(
                "not-verified",
                "Verify the report before changing its maintenance status."
            );

        }

        if (report.status === newStatus) return null;

        const patch = {
            status: newStatus,
            actualCompletion: newStatus === "Completed" ? now : "",
            statusHistory: report.statusHistory.concat({
                status: newStatus,
                date: now
            })
        };

        let roomItems = null;

        // Completing a repair removes this report's defects from the
        // room's damage count (once, even if the status is toggled).
        if (newStatus === "Completed" && !report.damageResolved) {

            const items = clone(room.items);
            const entry = findItem(items, report.item);

            if (entry) {

                entry.damage = formatDamage(
                    parseDamage(entry.damage) - report.quantity
                );

                roomItems = items;

            }

            patch.damageResolved = true;

        }

        return { reportPatch: patch, roomItems: roomItems };

    }

    function requireRole(session, roles) {

        if (!session || roles.indexOf(session.role) === -1) {

            throw new StoreError(
                "forbidden",
                "You don't have permission to do that."
            );

        }

    }

    function validateRoomNumber(roomNumber) {

        const value = String(roomNumber || "");

        if (!/^\d{1,4}$/.test(value)) {

            throw new StoreError("invalid-room", "That room doesn't exist.");

        }

        return value;

    }

    function mergeWithDefaultRooms(rooms) {

        const result = {};

        Object.keys(DEFAULT_ROOMS)
            .concat(Object.keys(rooms || {}))
            .forEach(function (roomNumber) {

                if (!result[roomNumber]) {

                    result[roomNumber] = normalizeRoom(
                        roomNumber,
                        rooms ? rooms[roomNumber] : null
                    );

                }

            });

        return result;

    }


    /* =====================================================
       LOCAL BACKEND  (localStorage demo mode)
       Uses the same storage keys as earlier versions, so
       data already saved on a device keeps working.
    ===================================================== */

    function createLocalBackend(options) {

        const local = options.local;
        const session = options.session;

        const INVENTORY_KEY = "buildSafeInventory";
        const REPORTS_KEY = "buildSafeMaintenanceReports";
        const REPORTS_BACKUP_KEY = "buildSafeMaintenanceReportsBackup";
        const ROLE_KEY = "buildSafeRole";

        const listeners = new Set();


        function readJson(key) {

            try {

                const text = local.getItem(key);

                return text ? JSON.parse(text) : null;

            } catch (error) {

                console.error("Could not read " + key + ":", error);

                return null;

            }

        }

        function writeJson(key, value) {

            try {

                local.setItem(key, JSON.stringify(value));

            } catch (error) {

                throw new StoreError(
                    "storage-full",
                    "This device has no room left to save data. Try a smaller photo."
                );

            }

        }

        function readReportList() {

            const main = readJson(REPORTS_KEY);

            if (Array.isArray(main)) return main;

            // Recover from the last good copy if the main data is unreadable.
            const backup = readJson(REPORTS_BACKUP_KEY);

            return Array.isArray(backup) ? backup : [];

        }

        function writeReportList(list) {

            try {

                local.setItem(REPORTS_BACKUP_KEY, JSON.stringify(list));

            } catch (error) {

                console.error("Could not save report backup:", error);

            }

            writeJson(REPORTS_KEY, list);

        }

        function getReports() {

            return readReportList().map(function (raw) {
                return normalizeReport(raw);
            });

        }

        function getSavedRooms() {

            const saved = readJson(INVENTORY_KEY);

            return saved && typeof saved === "object" ? saved : {};

        }

        function getRooms() {

            return mergeWithDefaultRooms(getSavedRooms());

        }

        function emit() {

            if (listeners.size === 0) return;

            const rooms = getRooms();
            const reports = getReports();

            listeners.forEach(function (handlers) {

                if (handlers.onRooms) handlers.onRooms(rooms);
                if (handlers.onReports) handlers.onReports(reports);

            });

        }

        function writeRoom(roomNumber, patch) {

            const saved = getSavedRooms();

            saved[roomNumber] = Object.assign(
                normalizeRoom(roomNumber, saved[roomNumber]),
                patch
            );

            writeJson(INVENTORY_KEY, saved);

        }

        // Keep several open tabs in sync.
        if (typeof window !== "undefined" && window.addEventListener) {

            window.addEventListener("storage", function (event) {

                if (event.key === INVENTORY_KEY || event.key === REPORTS_KEY) {
                    emit();
                }

            });

        }


        return {

            init: function () {
                return Promise.resolve();
            },

            getSession: function () {

                const role = session.getItem(ROLE_KEY);

                if (role !== ROLES.HEAD && role !== ROLES.TEACHER) {
                    return Promise.resolve(null);
                }

                return Promise.resolve({
                    uid: "local-" + role,
                    role: role,
                    name: ROLE_LABELS[role],
                    email: ""
                });

            },

            signIn: function (role) {

                session.setItem(ROLE_KEY, role);

                return this.getSession();

            },

            signOut: function () {

                session.removeItem(ROLE_KEY);

                return Promise.resolve();

            },

            subscribe: function (handlers) {

                listeners.add(handlers);

                // Deliver the current data right away, but asynchronously,
                // the same way the cloud backend does.
                Promise.resolve().then(function () {

                    if (!listeners.has(handlers)) return;

                    if (handlers.onRooms) handlers.onRooms(getRooms());
                    if (handlers.onReports) handlers.onReports(getReports());

                });

                return function () {
                    listeners.delete(handlers);
                };

            },

            saveRoom: function (roomNumber, patch) {

                writeRoom(roomNumber, patch);
                emit();

                return Promise.resolve();

            },

            addRoom: function (room) {

                if (getRooms()[room.roomNumber]) {

                    return Promise.reject(new StoreError(
                        "room-exists",
                        "Room " + room.roomNumber + " already exists."
                    ));

                }

                writeRoom(room.roomNumber, {
                    room: room.room,
                    building: room.building,
                    adviser: room.adviser,
                    photo: room.photo,
                    items: room.items
                });

                emit();

                return Promise.resolve();

            },

            addReport: function (report) {

                const list = readReportList();

                list.push(report);
                writeReportList(list);
                emit();

                return Promise.resolve(report);

            },

            transactReport: function (reportId, plan) {

                const list = readReportList();

                const index = list.findIndex(function (raw) {
                    return String(raw.id) === String(reportId);
                });

                if (index === -1) {

                    return Promise.reject(
                        new StoreError("not-found", "That report could not be found.")
                    );

                }

                try {

                    const report = normalizeReport(list[index]);
                    const room = getRooms()[report.roomNumber] ||
                        normalizeRoom(report.roomNumber, null);

                    const result = plan(report, room);

                    if (!result) return Promise.resolve({ changed: false });

                    list[index] = Object.assign({}, report, result.reportPatch);
                    writeReportList(list);

                    if (result.roomItems) {
                        writeRoom(report.roomNumber, { items: result.roomItems });
                    }

                    emit();

                    return Promise.resolve({ changed: true });

                } catch (error) {

                    return Promise.reject(error);

                }

            }

        };

    }


    /* =====================================================
       CLOUD BACKEND  (Firebase Auth + Cloud Firestore)

       Firestore layout
         users/{uid}       { role, displayName }   set in the console
         rooms/{roomNo}    { room, building, adviser, photo, items[] }
         reports/{id}      one maintenance report
    ===================================================== */

    async function loadFirebaseSdk() {

        const modules = await Promise.all([
            import(FIREBASE_SDK_URL + "firebase-app.js"),
            import(FIREBASE_SDK_URL + "firebase-auth.js"),
            import(FIREBASE_SDK_URL + "firebase-firestore.js")
        ]);

        return { app: modules[0], auth: modules[1], fs: modules[2] };

    }

    function mapFirebaseError(error) {

        if (error && error.isStoreError) return error;

        const code = String((error && error.code) || "");

        if (
            code === "auth/invalid-credential" ||
            code === "auth/wrong-password" ||
            code === "auth/user-not-found" ||
            code === "auth/invalid-email" ||
            code === "auth/missing-password"
        ) {
            return new StoreError("bad-credentials", "Incorrect account number or password.");
        }

        if (code === "auth/too-many-requests") {
            return new StoreError("rate-limited", "Too many attempts. Please wait a few minutes and try again.");
        }

        if (code === "auth/user-disabled") {
            return new StoreError("disabled", "This account has been disabled.");
        }

        if (code === "auth/operation-not-allowed") {
            return new StoreError("auth-disabled", "Email/password sign-in is not enabled in Firebase yet.");
        }

        if (
            code === "auth/network-request-failed" ||
            code === "unavailable" ||
            code === "failed-precondition" ||
            code === "deadline-exceeded"
        ) {
            return new StoreError("offline", "Can't reach the server. Check your internet connection and try again.");
        }

        if (code === "permission-denied") {
            return new StoreError("forbidden", "You don't have permission to do that.");
        }

        // Only unexpected problems are logged; the cases above are normal.
        console.error("Unexpected Firebase error:", error);

        return new StoreError("unknown", "Something went wrong. Please try again.");

    }

    // A Firestore write only resolves once the server confirms it. When the
    // device is offline the write is queued and syncs later, so don't make the
    // person wait: report it as queued after a short while.
    function settleOrQueue(promise) {

        return new Promise(function (resolve, reject) {

            const timer = setTimeout(function () {
                resolve({ queued: true });
            }, WRITE_TIMEOUT_MS);

            promise.then(
                function () {
                    clearTimeout(timer);
                    resolve({ queued: false });
                },
                function (error) {
                    clearTimeout(timer);
                    reject(error);
                }
            );

        });

    }

    function createCloudBackend(config, options) {

        const loadSdk = options.loadSdk || loadFirebaseSdk;

        let sdk = null;
        let auth = null;
        let db = null;
        let session = null;
        let initPromise = null;

        const seedAttempted = new Set();


        async function loadProfile(user) {

            const snapshot = await sdk.fs.getDoc(
                sdk.fs.doc(db, "users", user.uid)
            );

            if (!snapshot.exists()) return null;

            const data = snapshot.data();

            if (data.role !== ROLES.HEAD && data.role !== ROLES.TEACHER) {
                return null;
            }

            return {
                uid: user.uid,
                role: data.role,
                name: data.displayName || user.email || "",
                email: user.email || ""
            };

        }

        async function resolveSession() {

            await auth.authStateReady();

            if (!auth.currentUser) return null;

            const profile = await loadProfile(auth.currentUser);

            // Signed in to Firebase but not set up for BuildSafe.
            if (!profile) {

                await sdk.auth.signOut(auth);

                return null;

            }

            return profile;

        }

        function init() {

            if (initPromise) return initPromise;

            initPromise = (async function () {

                sdk = await loadSdk();

                const app = sdk.app.initializeApp(config);

                auth = sdk.auth.getAuth(app);

                if (options.persistentCache !== false) {

                    try {

                        db = sdk.fs.initializeFirestore(app, {
                            localCache: sdk.fs.persistentLocalCache({
                                tabManager: sdk.fs.persistentMultipleTabManager()
                            })
                        });

                    } catch (error) {

                        db = sdk.fs.getFirestore(app);

                    }

                } else {

                    db = sdk.fs.getFirestore(app);

                }

                if (options.emulator) {

                    sdk.auth.connectAuthEmulator(
                        auth,
                        options.emulator.auth,
                        { disableWarnings: true }
                    );

                    sdk.fs.connectFirestoreEmulator(
                        db,
                        options.emulator.firestoreHost,
                        options.emulator.firestorePort
                    );

                }

                session = await resolveSession();

            })();

            // Allow another attempt if loading failed (e.g. no internet).
            initPromise.catch(function () {
                initPromise = null;
            });

            return initPromise;

        }

        async function seedMissingRooms(existing) {

            const missing = Object.keys(DEFAULT_ROOMS).filter(function (roomNumber) {
                return !existing[roomNumber] && !seedAttempted.has(roomNumber);
            });

            for (let i = 0; i < missing.length; i++) {

                const roomNumber = missing[i];
                const ref = sdk.fs.doc(db, "rooms", roomNumber);

                seedAttempted.add(roomNumber);

                try {

                    await sdk.fs.runTransaction(db, async function (tx) {

                        const snapshot = await tx.get(ref);

                        if (!snapshot.exists()) {

                            tx.set(ref, Object.assign(
                                roomDocument(normalizeRoom(roomNumber, null)),
                                { updatedAt: nowIso(), updatedBy: "seed" }
                            ));

                        }

                    });

                } catch (error) {

                    console.warn("Could not create Room " + roomNumber + ":", error);

                }

            }

        }

        function roomDocument(room) {

            return {
                room: room.room,
                building: room.building,
                adviser: room.adviser,
                photo: room.photo,
                items: room.items
            };

        }

        function readRoomSnapshot(snapshot) {

            const rooms = {};

            snapshot.forEach(function (docSnap) {
                rooms[docSnap.id] = normalizeRoom(docSnap.id, docSnap.data());
            });

            return rooms;

        }


        return {

            init: init,

            getSession: async function () {

                await init();

                return session;

            },

            signIn: async function (role, account, password) {

                await init();

                if (!account || !password) {

                    throw new StoreError(
                        "missing-credentials",
                        "Enter your account number and password."
                    );

                }

                let credential;

                try {

                    credential = await sdk.auth.signInWithEmailAndPassword(
                        auth,
                        accountToEmail(account),
                        password
                    );

                } catch (error) {

                    throw mapFirebaseError(error);

                }

                let profile;

                try {

                    profile = await loadProfile(credential.user);

                } catch (error) {

                    await sdk.auth.signOut(auth);

                    throw mapFirebaseError(error);

                }

                if (!profile) {

                    await sdk.auth.signOut(auth);

                    throw new StoreError(
                        "no-profile",
                        "This account hasn't been set up for BuildSafe yet. Please contact the administrator."
                    );

                }

                if (profile.role !== role) {

                    await sdk.auth.signOut(auth);

                    throw new StoreError(
                        "wrong-role",
                        "This is not a " + ROLE_LABELS[role] + " account."
                    );

                }

                session = profile;

                return session;

            },

            signOut: async function () {

                await init();

                session = null;

                try {

                    await sdk.auth.signOut(auth);

                } catch (error) {

                    throw mapFirebaseError(error);

                }

            },

            subscribe: function (handlers) {

                let stopped = false;
                let stopRooms = function () {};
                let stopReports = function () {};

                init().then(function () {

                    if (stopped) return;

                    stopRooms = sdk.fs.onSnapshot(
                        sdk.fs.collection(db, "rooms"),
                        function (snapshot) {

                            const rooms = readRoomSnapshot(snapshot);

                            if (handlers.onRooms) {
                                handlers.onRooms(mergeWithDefaultRooms(rooms));
                            }

                            // Create the starting rooms the first time the
                            // collection is found empty on the server.
                            if (!snapshot.metadata.fromCache) {
                                seedMissingRooms(rooms);
                            }

                        },
                        function (error) {

                            if (handlers.onError) handlers.onError(mapFirebaseError(error));

                        }
                    );

                    stopReports = sdk.fs.onSnapshot(
                        sdk.fs.collection(db, "reports"),
                        function (snapshot) {

                            const reports = [];

                            snapshot.forEach(function (docSnap) {
                                reports.push(normalizeReport(docSnap.data(), docSnap.id));
                            });

                            if (handlers.onReports) handlers.onReports(reports);

                        },
                        function (error) {

                            if (handlers.onError) handlers.onError(mapFirebaseError(error));

                        }
                    );

                }).catch(function (error) {

                    if (handlers.onError) handlers.onError(mapFirebaseError(error));

                });

                return function () {

                    stopped = true;
                    stopRooms();
                    stopReports();

                };

            },

            saveRoom: async function (roomNumber, patch, actor) {

                await init();

                const ref = sdk.fs.doc(db, "rooms", roomNumber);

                const changes = Object.assign({}, patch, {
                    updatedAt: nowIso(),
                    updatedBy: actor.uid
                });

                try {

                    await settleOrQueue(sdk.fs.updateDoc(ref, changes));

                } catch (error) {

                    // The room document doesn't exist yet: create it.
                    if (error && error.code === "not-found") {

                        try {

                            await settleOrQueue(sdk.fs.setDoc(
                                ref,
                                Object.assign(
                                    roomDocument(normalizeRoom(roomNumber, null)),
                                    changes
                                )
                            ));

                            return;

                        } catch (createError) {

                            throw mapFirebaseError(createError);

                        }

                    }

                    throw mapFirebaseError(error);

                }

            },

            addRoom: async function (room, actor) {

                await init();

                const ref = sdk.fs.doc(db, "rooms", room.roomNumber);

                try {

                    await sdk.fs.runTransaction(db, async function (tx) {

                        const snapshot = await tx.get(ref);

                        if (snapshot.exists()) {

                            throw new StoreError(
                                "room-exists",
                                "Room " + room.roomNumber + " already exists."
                            );

                        }

                        tx.set(ref, Object.assign(
                            roomDocument(room),
                            { updatedAt: nowIso(), updatedBy: actor.uid }
                        ));

                    });

                } catch (error) {

                    throw mapFirebaseError(error);

                }

            },

            addReport: async function (report) {

                await init();

                const ref = sdk.fs.doc(sdk.fs.collection(db, "reports"));
                const saved = Object.assign({}, report, { id: ref.id });

                try {

                    await settleOrQueue(sdk.fs.setDoc(ref, saved));

                } catch (error) {

                    throw mapFirebaseError(error);

                }

                return saved;

            },

            transactReport: async function (reportId, plan) {

                await init();

                try {

                    return await sdk.fs.runTransaction(db, async function (tx) {

                        const reportRef = sdk.fs.doc(db, "reports", String(reportId));
                        const reportSnap = await tx.get(reportRef);

                        if (!reportSnap.exists()) {

                            throw new StoreError(
                                "not-found",
                                "That report could not be found."
                            );

                        }

                        const report = normalizeReport(reportSnap.data(), reportSnap.id);

                        const roomRef = sdk.fs.doc(db, "rooms", report.roomNumber);
                        const roomSnap = await tx.get(roomRef);

                        const room = normalizeRoom(
                            report.roomNumber,
                            roomSnap.exists() ? roomSnap.data() : null
                        );

                        const result = plan(report, room);

                        if (!result) return { changed: false };

                        tx.update(reportRef, result.reportPatch);

                        if (result.roomItems) {

                            const stamp = {
                                updatedAt: nowIso(),
                                updatedBy: session ? session.uid : ""
                            };

                            if (roomSnap.exists()) {

                                tx.update(roomRef, Object.assign(
                                    { items: result.roomItems },
                                    stamp
                                ));

                            } else {

                                tx.set(roomRef, Object.assign(
                                    roomDocument(Object.assign({}, room, { items: result.roomItems })),
                                    stamp
                                ));

                            }

                        }

                        return { changed: true };

                    });

                } catch (error) {

                    throw mapFirebaseError(error);

                }

            }

        };

    }


    /* =====================================================
       PUBLIC STORE
    ===================================================== */

    function createStore(options) {

        options = options || {};

        const config = options.config || {};
        const cloud = isConfigured(config);

        const backend = cloud
            ? createCloudBackend(config, options)
            : createLocalBackend({
                local: options.local || safeStorage("localStorage"),
                session: options.session || safeStorage("sessionStorage")
            });

        return {

            mode: cloud ? "cloud" : "local",

            // Resolves once the backend is ready (cloud: SDK loaded and
            // saved login restored). Rejects if Firebase can't be reached.
            ready: function () {
                return backend.init();
            },

            getSession: function () {
                return backend.getSession();
            },

            signIn: function (role, account, password) {

                if (role !== ROLES.HEAD && role !== ROLES.TEACHER) {

                    return Promise.reject(
                        new StoreError("invalid-role", "Unknown account type.")
                    );

                }

                return backend.signIn(
                    role,
                    String(account || "").trim(),
                    String(password || "")
                );

            },

            signOut: function () {
                return backend.signOut();
            },

            // handlers: { onRooms(rooms), onReports(reports), onError(error) }
            // Returns a function that stops listening.
            subscribe: function (handlers) {
                return backend.subscribe(handlers);
            },

            saveRoomInventory: async function (roomNumber, items, actor) {

                requireRole(actor, [ROLES.HEAD, ROLES.TEACHER]);

                const number = validateRoomNumber(roomNumber);
                const cleaned = normalizeItems(items);

                if (cleaned.length === 0 || cleaned.length > 50) {

                    throw new StoreError(
                        "invalid-inventory",
                        "The inventory list is not valid."
                    );

                }

                return backend.saveRoom(number, { items: cleaned }, actor);

            },

            saveRoomPhoto: async function (roomNumber, photo, actor) {

                requireRole(actor, [ROLES.HEAD, ROLES.TEACHER]);

                const number = validateRoomNumber(roomNumber);

                if (typeof photo !== "string" || photo.indexOf("data:image/") !== 0) {

                    throw new StoreError("invalid-photo", "Please choose an image file.");

                }

                if (photo.length > MAX_PHOTO_CHARS) {

                    throw new StoreError(
                        "photo-too-large",
                        "That photo is too large. Please choose a smaller one."
                    );

                }

                return backend.saveRoom(number, { photo: photo }, actor);

            },

            addRoom: async function (input, actor) {

                requireRole(actor, [ROLES.HEAD, ROLES.TEACHER]);

                const room = buildNewRoom(input || {});

                await backend.addRoom(room, actor);

                return room;

            },

            addReport: async function (input, actor) {

                requireRole(actor, [ROLES.TEACHER]);

                return backend.addReport(buildNewReport(input, nowIso(), actor.uid));

            },

            verifyReport: async function (reportId, actor) {

                requireRole(actor, [ROLES.HEAD]);

                return backend.transactReport(reportId, function (report, room) {
                    return planVerification(report, room, nowIso(), actor.uid);
                });

            },

            setReportStatus: async function (reportId, status, actor) {

                requireRole(actor, [ROLES.HEAD]);

                return backend.transactReport(reportId, function (report, room) {
                    return planStatusChange(report, room, status, nowIso());
                });

            }

        };

    }


    return {
        createStore: createStore,
        StoreError: StoreError,
        ROLES: ROLES,
        ROLE_LABELS: ROLE_LABELS,
        MAINTENANCE_STATUSES: MAINTENANCE_STATUSES,
        MAX_PHOTO_CHARS: MAX_PHOTO_CHARS,
        DEFAULT_ROOMS: DEFAULT_ROOMS,
        FIREBASE_SDK_VERSION: FIREBASE_SDK_VERSION,

        // Exposed for tests and for app.js display logic.
        core: {
            normalizeRoom: normalizeRoom,
            normalizeReport: normalizeReport,
            parseDamage: parseDamage,
            formatDamage: formatDamage,
            buildNewReport: buildNewReport,
            buildNewRoom: buildNewRoom,
            planVerification: planVerification,
            planStatusChange: planStatusChange,
            accountToEmail: accountToEmail,
            isConfigured: isConfigured
        }
    };

});
