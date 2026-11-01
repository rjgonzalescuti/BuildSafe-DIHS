/* =========================================================
   BUILDSAFE DIHS — APP

   All data goes through BuildSafeStore (store.js), which uses
   Firebase when firebase-config.js is filled in and this
   browser's storage otherwise.

   How every page works:
     1. Check who is signed in (and redirect if they shouldn't be here)
     2. Subscribe to rooms + reports
     3. render() redraws whatever the current page shows
        whenever the data changes (including changes made on
        another device).
========================================================= */

(function () {

    "use strict";

    const store = window.BuildSafeStore;
    const ROLES = window.BuildSafe.ROLES;
    const ROLE_LABELS = window.BuildSafe.ROLE_LABELS;
    const MAX_PHOTO_CHARS = window.BuildSafe.MAX_PHOTO_CHARS;
    const core = window.BuildSafe.core;


    /* =====================================================
       PAGES & ACCESS
    ===================================================== */

    const HOME_BY_ROLE = {
        schoolHead: "dashboard-head.html",
        teacher: "dashboard.html"
    };

    // Pages that need a signed-in user, and who may open them.
    const PAGE_ACCESS = {
        "dashboard.html": [ROLES.TEACHER],
        "dashboard-head.html": [ROLES.HEAD],
        "inventory.html": [ROLES.TEACHER, ROLES.HEAD],
        "reports.html": [ROLES.HEAD],
        "reports-inside.html": [ROLES.HEAD]
    };

    const PAGE = decodeURIComponent(
        window.location.pathname.split("/").pop() || "index.html"
    ).toLowerCase();

    const DEFAULT_ROOM_NUMBER = "18";


    /* =====================================================
       STATE
    ===================================================== */

    const state = {
        session: null,
        rooms: {},
        reports: [],
        loaded: { rooms: false, reports: false },
        editingInventory: false
    };

    const runningActions = new Set();


    /* =====================================================
       GENERAL HELPERS
    ===================================================== */

    function byId(id) {
        return document.getElementById(id);
    }

    function setText(id, text) {

        const element = byId(id);

        if (element) element.textContent = text;

    }

    function setDisplay(id, display) {

        const element = byId(id);

        if (element) element.style.display = display;

    }

    function escapeHtml(value) {

        return String(value == null ? "" : value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");

    }

    function sameText(a, b) {

        return String(a == null ? "" : a).trim().toLowerCase() ===
            String(b == null ? "" : b).trim().toLowerCase();

    }

    function newestFirst(a, b) {

        return new Date(b.dateReported || 0) - new Date(a.dateReported || 0);

    }

    function isPending(report) {
        return report.verification !== "Verified";
    }

    function statusClass(status) {

        return String(status).toLowerCase().replace(/\s+/g, "-");

    }

    function formatDate(value) {

        if (!value) return "—";

        const date = new Date(value);

        if (isNaN(date.getTime())) return String(value);

        return date.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric"
        });

    }

    function formatDateTime(value) {

        if (!value) return "—";

        const date = new Date(value);

        if (isNaN(date.getTime())) return String(value);

        return date.toLocaleString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit"
        });

    }

    function getQueryParam(name) {

        return new URLSearchParams(window.location.search).get(name);

    }

    function getCurrentRoomNumber() {

        return getQueryParam("room") || DEFAULT_ROOM_NUMBER;

    }

    function getCurrentReportId() {

        return getQueryParam("id");

    }

    function redirect(url) {

        window.location.replace(url);

    }


    /* =====================================================
       FEEDBACK  (toast messages, errors, double-click guard)
    ===================================================== */

    function notify(message, type) {

        let box = byId("toast");

        if (!box) {

            box = document.createElement("div");
            box.id = "toast";
            box.setAttribute("role", "status");
            box.setAttribute("aria-live", "polite");

            document.body.appendChild(box);

        }

        box.textContent = message;
        box.className = "toast show " + (type || "info");

        clearTimeout(notify.timer);

        notify.timer = setTimeout(function () {
            box.classList.remove("show");
        }, 3800);

    }

    function errorMessage(error) {

        if (error && error.isStoreError) return error.message;

        console.error(error);

        return "Something went wrong. Please try again.";

    }

    // Runs an action, ignoring repeat clicks until it finishes and
    // showing any error the same way everywhere.
    async function runAction(key, task) {

        if (runningActions.has(key)) return;

        runningActions.add(key);

        try {

            return await task();

        } catch (error) {

            notify(errorMessage(error), "error");

        } finally {

            runningActions.delete(key);

        }

    }

    function requireData() {

        if (state.loaded.rooms && state.loaded.reports) return true;

        notify("Still loading — please try again in a moment.", "info");

        return false;

    }


    /* =====================================================
       PHOTOS
       Photos are shrunk before saving so they fit in the database.
    ===================================================== */

    function readPhoto(file) {

        return new Promise(function (resolve, reject) {

            if (!file || file.type.indexOf("image/") !== 0) {

                reject(new window.BuildSafe.StoreError(
                    "invalid-photo",
                    "Please choose an image file."
                ));

                return;

            }

            const url = URL.createObjectURL(file);
            const image = new Image();

            image.onload = function () {

                URL.revokeObjectURL(url);

                const longestSide = 960;

                const scale = Math.min(
                    1,
                    longestSide / Math.max(image.width, image.height)
                );

                const canvas = document.createElement("canvas");

                canvas.width = Math.max(1, Math.round(image.width * scale));
                canvas.height = Math.max(1, Math.round(image.height * scale));

                canvas.getContext("2d").drawImage(
                    image, 0, 0, canvas.width, canvas.height
                );

                let quality = 0.8;
                let data = canvas.toDataURL("image/jpeg", quality);

                while (data.length > MAX_PHOTO_CHARS && quality > 0.35) {

                    quality -= 0.1;
                    data = canvas.toDataURL("image/jpeg", quality);

                }

                if (data.length > MAX_PHOTO_CHARS) {

                    reject(new window.BuildSafe.StoreError(
                        "photo-too-large",
                        "That photo is too large. Please choose a smaller one."
                    ));

                    return;

                }

                resolve(data);

            };

            image.onerror = function () {

                URL.revokeObjectURL(url);

                reject(new window.BuildSafe.StoreError(
                    "invalid-photo",
                    "That image could not be read."
                ));

            };

            image.src = url;

        });

    }


    /* =====================================================
       LOGIN / LOGOUT
    ===================================================== */

    function showLoginError(role, message) {

        const id = role === ROLES.HEAD ? "schoolHeadError" : "teacherError";

        setText(id, message || "");

    }

    async function signInAs(role, event) {

        if (event) event.preventDefault();

        const prefix = role === ROLES.HEAD ? "schoolHead" : "teacher";

        const account = byId(prefix + "Account");
        const password = byId(prefix + "Password");

        if (runningActions.has("login")) return;

        runningActions.add("login");

        showLoginError(ROLES.HEAD, "");
        showLoginError(ROLES.TEACHER, "");

        try {

            const session = await store.signIn(
                role,
                account ? account.value : "",
                password ? password.value : ""
            );

            window.location.href = HOME_BY_ROLE[session.role];

        } catch (error) {

            showLoginError(role, errorMessage(error));

        } finally {

            runningActions.delete("login");

        }

    }

    function schoolHeadLogin(event) {
        return signInAs(ROLES.HEAD, event);
    }

    function teacherAdviserLogin(event) {
        return signInAs(ROLES.TEACHER, event);
    }

    async function logout() {

        await runAction("logout", async function () {

            await store.signOut();

            window.location.href = "index.html";

        });

    }

    function initLoginPage() {

        const cloud = store.mode === "cloud";

        // Passwords are only used with a real Firebase login.
        document.querySelectorAll("[data-cloud-only]").forEach(function (element) {
            element.style.display = cloud ? "" : "none";
        });

        setText(
            "modeNotice",
            cloud
                ? ""
                : "Demo mode: Firebase is not connected yet, so data is saved on this device only."
        );

        // A saved Firebase login skips the form.
        if (cloud && state.session) {
            redirect(HOME_BY_ROLE[state.session.role]);
        }

    }


    /* =====================================================
       NAVIGATION
    ===================================================== */

    function goToDashboard() {

        const role = state.session && state.session.role;

        window.location.href = HOME_BY_ROLE[role] || "index.html";

    }

    // Each role's classroom list lives on its dashboard.
    function goToClassroom() {
        goToDashboard();
    }

    function goToReports() {

        window.location.href = "reports.html";

    }

    function openInventory(roomNumber) {

        window.location.href =
            "inventory.html?room=" + encodeURIComponent(roomNumber);

    }

    function openReportById(reportId) {

        if (!reportId) {

            notify("No report selected.", "error");

            return;

        }

        window.location.href =
            "reports-inside.html?id=" + encodeURIComponent(reportId);

    }

    // Opens a room's most urgent report: unverified ones first, newest first.
    function openReport(roomNumber) {

        if (!requireData()) return;

        const reports = reportsForRoom(roomNumber).sort(function (a, b) {

            if (isPending(a) !== isPending(b)) return isPending(a) ? -1 : 1;

            return newestFirst(a, b);

        });

        if (reports.length === 0) {

            notify("There are no reports for Room " + roomNumber + " yet.", "info");

            return;

        }

        openReportById(reports[0].id);

    }


    /* =====================================================
       SEARCH  (both dashboards)
    ===================================================== */

    function searchDashboard() {

        const input = byId("searchInput");

        if (!input) return;

        const term = input.value.toLowerCase().trim();

        document.querySelectorAll(".room-card").forEach(function (card) {

            card.style.display =
                card.innerText.toLowerCase().includes(term) ? "" : "none";

        });

    }


    /* =====================================================
       DATA LOOKUPS
    ===================================================== */

    function reportsForRoom(roomNumber) {

        return state.reports.filter(function (report) {
            return String(report.roomNumber) === String(roomNumber);
        });

    }

    function currentReport() {

        const id = getCurrentReportId();

        return state.reports.find(function (report) {
            return String(report.id) === String(id);
        });

    }

    function lastUpdateOf(report) {

        if (report.statusHistory.length > 0) {

            return report.statusHistory[report.statusHistory.length - 1];

        }

        return {
            status: report.verification,
            date: report.dateReported
        };

    }

    function displayStatus(report) {

        return isPending(report)
            ? "Pending Verification"
            : (report.status || "Awaiting Status");

    }

    function statusBadge(cssClass, label) {

        return '<span class="inventory-status ' +
            escapeHtml(cssClass) + '">' +
            escapeHtml(label) + "</span>";

    }

    // The badge shown next to an inventory item.
    function inventoryStatusBadge(roomNumber, itemName) {

        const reports = reportsForRoom(roomNumber)
            .filter(function (report) {
                return sameText(report.item, itemName);
            })
            .sort(newestFirst);

        if (reports.length === 0) {
            return statusBadge("no-report", "No Report");
        }

        const report = reports[0];

        if (isPending(report)) {
            return statusBadge("pending-verification", "Pending Verification");
        }

        const status = report.status || "Awaiting Status";

        return statusBadge(statusClass(status), status);

    }


    /* =====================================================
       RENDER — INVENTORY PAGE
    ===================================================== */

    function renderInventoryPage() {

        const body = byId("inventoryTableBody");

        if (!body) return;

        const roomNumber = getCurrentRoomNumber();
        const room = state.rooms[roomNumber];

        if (!room) {

            notify("That room doesn't exist.", "error");

            setTimeout(goToDashboard, 1200);

            return;

        }

        setText("roomTitle", room.room);
        setText("buildingName", room.building);
        setText("roomAdviser", room.building + " | Room Adviser: " + room.adviser);

        ["classroomPhoto", "roomPhoto"].forEach(function (id) {

            const image = byId(id);

            if (image && room.photo && image.getAttribute("src") !== room.photo) {
                image.src = room.photo;
            }

        });

        // Don't wipe the table while someone is typing in it.
        if (state.editingInventory) return;

        body.innerHTML = room.items.map(function (entry, index) {

            return "<tr>" +
                "<td>" + escapeHtml(entry.item) + "</td>" +
                "<td>" +
                '<input class="inventory-quantity" type="number" min="0" step="1" ' +
                'value="' + escapeHtml(entry.quantity) + '" disabled data-index="' + index + '">' +
                "</td>" +
                "<td>" +
                '<input class="inventory-damage" type="text" maxlength="60" ' +
                'value="' + escapeHtml(entry.damage) + '" disabled data-index="' + index + '">' +
                "</td>" +
                '<td><span class="status locked">' +
                inventoryStatusBadge(roomNumber, entry.item) +
                "</span></td>" +
                "</tr>";

        }).join("");

    }

    function setInventoryEditMode(editing) {

        state.editingInventory = editing;

        document.querySelectorAll(
            ".inventory-quantity, .inventory-damage"
        ).forEach(function (input) {
            input.disabled = !editing;
        });

        setDisplay("updateInventoryButton", editing ? "none" : "inline-block");
        setDisplay("saveInventoryButton", editing ? "inline-block" : "none");

    }

    function enableInventoryEdit() {

        if (!requireData()) return;

        setInventoryEditMode(true);

    }

    function saveInventoryChanges() {

        return runAction("save-inventory", async function () {

            if (!requireData()) return;

            const roomNumber = getCurrentRoomNumber();
            const room = state.rooms[roomNumber];

            if (!room) return;

            const items = room.items.map(function (entry) {
                return Object.assign({}, entry);
            });

            let invalid = false;

            document.querySelectorAll(".inventory-quantity").forEach(function (input) {

                const quantity = Number(input.value);

                if (
                    input.value.trim() === "" ||
                    !Number.isInteger(quantity) ||
                    quantity < 0
                ) {
                    invalid = true;
                    return;
                }

                items[Number(input.dataset.index)].quantity = quantity;

            });

            if (invalid) {

                notify("Quantity must be a whole number, 0 or more.", "error");

                return;

            }

            document.querySelectorAll(".inventory-damage").forEach(function (input) {

                items[Number(input.dataset.index)].damage =
                    input.value.trim() || "None";

            });

            await store.saveRoomInventory(roomNumber, items, state.session);

            setInventoryEditMode(false);

            render();

            notify("Inventory changes saved.", "success");

        });

    }

    // Kept for the older inventory page, which calls this name.
    function saveInventory() {
        return saveInventoryChanges();
    }

    function changeRoomPhoto(event) {

        const input = event && event.target;
        const file = input && input.files && input.files[0];

        if (!file) return;

        return runAction("room-photo", async function () {

            const photo = await readPhoto(file);

            await store.saveRoomPhoto(getCurrentRoomNumber(), photo, state.session);

            ["classroomPhoto", "roomPhoto"].forEach(function (id) {

                const image = byId(id);

                if (image) image.src = photo;

            });

            notify("Classroom photo updated.", "success");

        }).finally(function () {

            // Allow choosing the same file again.
            input.value = "";

        });

    }


    /* =====================================================
       RENDER — REPORT LISTS & COUNTS
    ===================================================== */

    // Teacher: maintenance history table on the inventory page.
    function renderTeacherHistory() {

        const body = byId("maintenanceReports");

        if (!body) return;

        const reports = reportsForRoom(getCurrentRoomNumber()).sort(newestFirst);

        if (reports.length === 0) {

            body.innerHTML =
                '<tr><td colspan="4">No maintenance history for this room yet.</td></tr>';

            return;

        }

        body.innerHTML = reports.map(function (report) {

            return "<tr>" +
                "<td>" + escapeHtml(itemLabel(report) || "—") + "</td>" +
                "<td>" + escapeHtml(report.quantity || "—") + "</td>" +
                "<td>" + escapeHtml(displayStatus(report)) + "</td>" +
                "<td>" + escapeHtml(formatDateTime(lastUpdateOf(report).date)) + "</td>" +
                "</tr>";

        }).join("");

    }

    // School head: full list of reports (used when a page provides the container).
    function renderHeadReports() {

        const container = byId("headMaintenanceReports");

        if (!container) return;

        if (state.reports.length === 0) {

            container.innerHTML =
                '<div class="maintenance-report">' +
                "<h3>No maintenance reports yet.</h3>" +
                "<p>Teacher reports will appear here.</p>" +
                "</div>";

            return;

        }

        container.innerHTML = state.reports
            .slice()
            .sort(newestFirst)
            .map(function (report) {

                return '<div class="maintenance-report">' +
                    "<h3>" + escapeHtml(report.room) + "</h3>" +
                    '<div class="report-information">' +
                    "<p><strong>Item:</strong> " + escapeHtml(itemLabel(report)) + "</p>" +
                    "<p><strong>Quantity:</strong> " + escapeHtml(report.quantity) + "</p>" +
                    "<p><strong>Concern:</strong> " + escapeHtml(report.concern) + "</p>" +
                    "<p><strong>Defect:</strong> " + escapeHtml(report.defectKind || "—") + "</p>" +
                    "<p><strong>Action:</strong> " + escapeHtml(report.action || "—") + "</p>" +
                    "<p><strong>Reported:</strong> " +
                    escapeHtml(formatDateTime(report.dateReported)) + "</p>" +
                    "<p><strong>Verification:</strong> " +
                    escapeHtml(report.verification) + "</p>" +
                    "<p><strong>Maintenance:</strong> " +
                    escapeHtml(report.status || "Awaiting Status") + "</p>" +
                    '<button type="button" data-report-id="' + escapeHtml(report.id) + '">' +
                    "View Report</button>" +
                    "</div></div>";

            }).join("");

        container.querySelectorAll("[data-report-id]").forEach(function (button) {

            button.addEventListener("click", function () {
                openReportById(button.dataset.reportId);
            });

        });

    }

    // "NEW UPDATE" badges on the reports page.
    function renderRoomBadges() {

        let roomsWithPending = 0;

        Object.keys(state.rooms).forEach(function (roomNumber) {

            const badge = byId("newUpdate" + roomNumber);

            if (!badge) return;

            const hasPending = reportsForRoom(roomNumber).some(isPending);

            badge.textContent = "NEW UPDATE";
            badge.style.display = hasPending ? "inline-block" : "none";

            if (hasPending) roomsWithPending++;

        });

        const total = byId("newReportBadge");

        if (total) {

            total.textContent = roomsWithPending +
                (roomsWithPending === 1 ? " New Update" : " New Updates");

            total.style.display = "inline-block";

        }

    }

    function renderHeadSummary() {

        const reports = state.reports;

        setText("totalReports", reports.length);

        setText("pendingReports", reports.filter(isPending).length);

        setText("verifiedReports", reports.filter(function (report) {
            return !isPending(report);
        }).length);

        setText("completedReports", reports.filter(function (report) {
            return report.status === "Completed";
        }).length);

    }


    /* =====================================================
       RENDER — REPORT DETAILS PAGE
    ===================================================== */

    function renderTimeline(report) {

        if (report.statusHistory.length === 0) {
            return "<p>No history available.</p>";
        }

        return report.statusHistory.map(function (entry) {

            return '<div class="timeline-item">' +
                '<div class="timeline-dot"></div>' +
                '<div class="timeline-content">' +
                "<strong>" + escapeHtml(entry.status) + "</strong>" +
                "<span>" + escapeHtml(formatDateTime(entry.date)) + "</span>" +
                "</div></div>";

        }).join("");

    }

    function renderVerificationControls(report) {

        const verified = !isPending(report);

        setText("detailVerification", report.verification);
        setText("detailVerifiedDate", report.verifiedDate ? formatDate(report.verifiedDate) : "—");

        const badge = byId("reportVerificationBadge");

        if (badge) {

            badge.textContent = report.verification;
            badge.style.background = verified ? "#e8f5e9" : "#fff3cd";
            badge.style.color = verified ? "#2e7d32" : "#856404";

        }

        const button = byId("verifyReportButton");

        if (button) {

            button.textContent = verified ? "✓ Report Verified" : "✓ Verify Report";
            button.disabled = verified;
            button.style.opacity = verified ? "0.6" : "1";

        }

        // Maintenance controls unlock once the report is verified.
        setDisplay("maintenanceControls", verified ? "block" : "none");
        setDisplay("maintenanceLocked", verified ? "none" : "block");

        const select = byId("repairStatus");

        if (select) select.value = report.status || "";

    }

    function renderReportDetails() {

        const roomLabel = byId("detailRoom");

        if (!roomLabel) return;

        const report = currentReport();

        if (!report) {

            roomLabel.textContent = "No report selected";

            ["detailItem", "detailQuantity", "detailConcern", "detailReported"]
                .forEach(function (id) {
                    setText(id, "—");
                });

            setText("detailDescription", "No report was selected.");
            setDisplay("detailPhotoWrap", "none");

            return;

        }

        const room = state.rooms[report.roomNumber];

        roomLabel.textContent =
            report.room + " • " + (room ? room.building : "Building 17");

        setText("detailItem", itemLabel(report) || "—");
        setText("detailDefect", report.defectKind || "—");
        setText("detailAction", report.action || "—");
        setText("detailQuantity", report.quantity || "—");
        setText("detailConcern", report.concern || "—");
        setText("detailReported", formatDate(report.dateReported));
        setText("detailDescription", report.description || "No additional description.");
        setText("detailStatus", displayStatus(report));
        setText("detailLastUpdated", formatDateTime(lastUpdateOf(report).date));

        const photo = byId("detailPhoto");

        if (photo) {

            photo.src = report.photo || "";
            setDisplay("detailPhotoWrap", report.photo ? "block" : "none");

        }

        renderVerificationControls(report);

        const timeline = byId("reportTimeline");

        if (timeline) timeline.innerHTML = renderTimeline(report);

    }


    /* =====================================================
       RENDER — EVERYTHING
    ===================================================== */

    /* =====================================================
       CLASSROOM LISTS  (built from the database, so rooms
       that people add appear automatically)
    ===================================================== */

    function sortedRoomNumbers() {

        return Object.keys(state.rooms).sort(function (a, b) {
            return Number(a) - Number(b);
        });

    }

    function renderRoomCards() {

        const container = byId("roomCards");

        if (!container) return;

        const numbers = sortedRoomNumbers();

        if (numbers.length === 0) {

            container.innerHTML =
                '<p class="empty-note">No classrooms yet. Use "Add Classroom" to create one.</p>';

            return;

        }

        container.innerHTML = numbers.map(function (roomNumber) {

            const room = state.rooms[roomNumber];

            const detail = "<strong>View Classroom</strong>" +
                '<span class="room-info">Inventory • Condition • Reports</span>';

            return '<button type="button" class="room-card" data-room="' +
                escapeHtml(roomNumber) + '">' +
                "<h3>" + escapeHtml(room.room) + "</h3>" +
                "<p>" + escapeHtml(room.building) + "</p>" +
                detail +
                "</button>";

        }).join("");

        container.querySelectorAll("[data-room]").forEach(function (card) {

            card.addEventListener("click", function () {
                openInventory(card.dataset.room);
            });

        });

        // Keep an active search filter applied after the list refreshes.
        const search = byId("searchInput");

        if (search && search.value.trim()) searchDashboard();

    }

    // Reports page (School Head): one row per classroom.
    function renderReportRooms() {

        const container = byId("reportRoomList");

        if (!container) return;

        container.innerHTML = sortedRoomNumbers().map(function (roomNumber) {

            const room = state.rooms[roomNumber];

            return '<button type="button" class="Room-Report" data-room="' +
                escapeHtml(roomNumber) + '">' +
                "<div><h2>" + escapeHtml(room.room) + "</h2>" +
                "<p>" + escapeHtml(room.building) + "</p></div>" +
                '<span id="newUpdate' + escapeHtml(roomNumber) +
                '" class="new-update" style="display:none;">NEW UPDATE</span>' +
                "</button>";

        }).join("");

        container.querySelectorAll("[data-room]").forEach(function (row) {

            row.addEventListener("click", function () {
                openReport(row.dataset.room);
            });

        });

    }


    /* =====================================================
       ADD CLASSROOM  (pop-up form on both dashboards)
    ===================================================== */

    function showModal(id) {

        const modal = byId(id);

        if (!modal) return;

        modal.hidden = false;

        const first = modal.querySelector("input, select, textarea");

        if (first) first.focus();

    }

    function hideModal(id) {

        const modal = byId(id);

        if (modal) modal.hidden = true;

    }

    function openAddRoom() {

        showModal("addRoomModal");

    }

    function closeAddRoom() {

        hideModal("addRoomModal");

    }

    function submitAddRoom(event) {

        if (event) event.preventDefault();

        return runAction("add-room", async function () {

            if (!requireData()) return;

            const room = await store.addRoom({
                roomNumber: byId("newRoomNumber").value,
                building: byId("newRoomBuilding").value,
                adviser: byId("newRoomAdviser").value
            }, state.session);

            const form = byId("addRoomForm");

            if (form) form.reset();

            closeAddRoom();

            notify(room.room + " was added.", "success");

        });

    }


    /* =====================================================
       ADD REPORT  (pop-up form on the teacher dashboard)
    ===================================================== */

    /* =====================================================
       REPORT FORM OPTIONS  (depend on the item chosen)
    ===================================================== */

    const ITEM_GUIDE = {
        "armchairs": {
            detailLabel: "Type of chair",
            details: ["Armchair", "Chair without armrest", "Other"],
            defects: ["Broken arm rest", "Unstable", "Missing leg", "Torn or broken seat", "Other"]
        },
        "tables": {
            detailLabel: "Type of table",
            details: ["Student table", "Teacher's table", "Other"],
            defects: ["Unstable", "Broken leg", "Cracked or broken top", "Missing part", "Other"]
        },
        "door": {
            detailLabel: "Which door",
            details: ["Front door", "Back door", "Other"],
            defects: ["Broken lock", "Broken hinge", "Cannot open or close", "Damaged panel", "Other"]
        },
        "windows": {
            detailLabel: "Window position",
            details: ["Front, facing the hallway", "Back, facing outside", "Other"],
            defects: ["Broken glass", "Missing glass", "Cannot open or close", "Broken frame or latch", "Other"]
        },
        "lights": {
            detailLabel: "Type of light",
            details: ["Ceiling light", "Wall light", "Other"],
            defects: ["Not working", "Flickering", "Broken fixture", "Missing", "Other"]
        },
        "electrical outlets": {
            detailLabel: "Outlet location",
            details: ["Front wall", "Back wall", "Left wall", "Right wall", "Other"],
            defects: ["No power", "Loose or not secure", "Burnt or scorched", "Exposed wires", "Broken cover", "Other"]
        },
        "electric fans": {
            detailLabel: "Type of fan",
            details: ["Ceiling fan", "Wall fan", "Stand fan", "Other"],
            defects: ["Not working", "Noisy", "Wobbling", "Broken blade", "Broken switch", "Other"]
        }
    };

    const GENERAL_DEFECTS = ["Damaged", "Broken", "Missing", "Other"];

    function optionList(values) {

        return '<option value="">Select</option>' + values.map(function (value) {
            return "<option>" + escapeHtml(value) + "</option>";
        }).join("");

    }

    // Builds the extra fields under "Item / Facility": which kind of item,
    // what kind of defect, and whether it is for repair or for disposal.
    function renderReportExtras(prefix) {

        const holder = byId(prefix + "Extra");
        const itemSelect = byId(prefix + "Item");

        if (!holder || !itemSelect) return;

        if (!itemSelect.value) {

            holder.innerHTML = "";

            return;

        }

        const guide = ITEM_GUIDE[itemSelect.value.toLowerCase()] || null;
        const defects = guide ? guide.defects : GENERAL_DEFECTS;

        let html = "";

        if (guide) {

            html += '<label for="' + prefix + 'Detail">' + escapeHtml(guide.detailLabel) +
                '<select id="' + prefix + 'Detail" data-other="' + prefix + 'DetailOther" required>' +
                optionList(guide.details) + "</select></label>" +
                '<label for="' + prefix + 'DetailOther" id="' + prefix + 'DetailOtherBox" hidden>' +
                "Please specify" +
                '<input type="text" id="' + prefix + 'DetailOther" maxlength="100"></label>';

        } else {

            html += '<label for="' + prefix + 'DetailOther">Specify the item' +
                '<input type="text" id="' + prefix + 'DetailOther" maxlength="100" required></label>';

        }

        html += '<label for="' + prefix + 'Defect">Kind of defect' +
            '<select id="' + prefix + 'Defect" data-other="' + prefix + 'DefectOther" required>' +
            optionList(defects) + "</select></label>" +
            '<label for="' + prefix + 'DefectOther" id="' + prefix + 'DefectOtherBox" hidden>' +
            "Please specify" +
            '<input type="text" id="' + prefix + 'DefectOther" maxlength="100"></label>';

        html += '<label for="' + prefix + 'Action">Recommended action' +
            '<select id="' + prefix + 'Action" required>' +
            optionList(["For repair", "For disposal"]) + "</select></label>";

        holder.innerHTML = html;

    }

    // Show the "Please specify" box only when "Other" is chosen.
    function onExtraChange(event) {

        const select = event.target;
        const otherId = select && select.dataset ? select.dataset.other : "";

        if (!otherId) return;

        const box = byId(otherId + "Box");
        const input = byId(otherId);
        const isOther = select.value === "Other";

        if (box) box.hidden = !isOther;

        if (input) {

            input.required = isOther;

            if (!isOther) input.value = "";

        }

    }

    function readReportExtras(prefix) {

        function pick(selectId, otherId) {

            const select = byId(selectId);
            const other = byId(otherId);
            const typed = other ? other.value.trim() : "";

            if (!select) return typed;

            return select.value === "Other" ? typed : select.value;

        }

        const action = byId(prefix + "Action");

        return {
            itemDetail: pick(prefix + "Detail", prefix + "DetailOther"),
            defectKind: pick(prefix + "Defect", prefix + "DefectOther"),
            action: action ? action.value : ""
        };

    }

    function setupReportExtras(prefix) {

        const itemSelect = byId(prefix + "Item");
        const holder = byId(prefix + "Extra");

        if (!itemSelect || !holder || itemSelect.dataset.extrasReady) return;

        itemSelect.dataset.extrasReady = "1";

        itemSelect.addEventListener("change", function () {
            renderReportExtras(prefix);
        });

        holder.addEventListener("change", onExtraChange);

        const form = itemSelect.closest("form");

        if (form) {

            form.addEventListener("reset", function () {
                setTimeout(function () { renderReportExtras(prefix); }, 0);
            });

        }

        renderReportExtras(prefix);

    }

    // "Armchairs (Armchair)" style label used in lists.
    function itemLabel(report) {

        return report.itemDetail
            ? report.item + " (" + report.itemDetail + ")"
            : report.item;

    }

    function fillReportItems() {

        const roomSelect = byId("newReportRoom");
        const itemSelect = byId("newReportItem");

        if (!roomSelect || !itemSelect) return;

        const room = state.rooms[roomSelect.value];
        const names = room ? room.items.map(function (entry) { return entry.item; }) : [];

        if (names.indexOf("Other") === -1) names.push("Other");

        itemSelect.innerHTML = '<option value="">Select item</option>' +
            names.map(function (name) {
                return "<option>" + escapeHtml(name) + "</option>";
            }).join("");

        setupReportExtras("newReport");
        renderReportExtras("newReport");

    }

    function openAddReport() {

        if (!requireData()) return;

        const roomSelect = byId("newReportRoom");

        if (!roomSelect) return;

        const numbers = sortedRoomNumbers();

        if (numbers.length === 0) {

            notify("Add a classroom first, then you can report a problem in it.", "info");

            return;

        }

        const previous = roomSelect.value;

        roomSelect.innerHTML = numbers.map(function (roomNumber) {

            const room = state.rooms[roomNumber];

            return '<option value="' + escapeHtml(roomNumber) + '">' +
                escapeHtml(room.room) + " (" + escapeHtml(room.building) + ")</option>";

        }).join("");

        if (previous && state.rooms[previous]) roomSelect.value = previous;

        fillReportItems();

        showModal("addReportModal");

    }

    function closeAddReport() {

        hideModal("addReportModal");

    }

    function submitAddReport(event) {

        if (event) event.preventDefault();

        return runAction("add-report", async function () {

            if (!requireData()) return;

            const photoInput = byId("newReportPhoto");
            const photoFile = photoInput && photoInput.files && photoInput.files[0];

            const photo = photoFile ? await readPhoto(photoFile) : "";

            const roomNumber = byId("newReportRoom").value;

            await store.addReport(Object.assign({
                roomNumber: roomNumber,
                item: byId("newReportItem").value,
                quantity: byId("newReportQuantity").value,
                concern: byId("newReportType").value,
                description: byId("newReportDescription").value,
                photo: photo
            }, readReportExtras("newReport")), state.session);

            const form = byId("addReportForm");

            if (form) form.reset();

            closeAddReport();

            notify("Defect report for Room " + roomNumber + " submitted.", "success");

        });

    }

    document.addEventListener("keydown", function (event) {

        if (event.key !== "Escape") return;

        closeAddRoom();
        closeAddReport();

    });

    document.addEventListener("click", function (event) {

        // Clicking the dark area outside a pop-up closes it.
        if (event.target && event.target.classList &&
            event.target.classList.contains("modal-backdrop")) {

            event.target.hidden = true;

        }

    });


    // Summary cards at the top of both dashboards.
    function renderStats() {

        const container = byId("statCards");

        if (!container) return;

        const isHead = state.session && state.session.role === ROLES.HEAD;

        const pending = state.reports.filter(isPending).length;
        const completed = state.reports.filter(function (report) {
            return report.status === "Completed";
        }).length;
        const open = state.reports.length - completed;

        const cards = [
            { label: "Classrooms", value: Object.keys(state.rooms).length,
              note: "Registered rooms", dark: true, bars: [50, 80, 40, 95, 60] },
            isHead
                ? { label: "Awaiting Verification", value: pending,
                    note: pending ? "Needs your review" : "All caught up", bars: [30, 70, 45, 85, 55] }
                : { label: "Open Reports", value: open,
                    note: open ? "Not yet completed" : "No open problems", bars: [30, 70, 45, 85, 55] },
            { label: "Completed Repairs", value: completed,
              note: "Marked Completed", bars: [40, 55, 75, 60, 90] }
        ];

        container.innerHTML = cards.map(function (card) {

            return '<div class="stat-card' + (card.dark ? " stat-dark" : "") + '">' +
                '<div class="stat-label">' + escapeHtml(card.label) + "</div>" +
                '<div class="stat-value">' + card.value + "</div>" +
                '<div class="stat-note">' + escapeHtml(card.note) + "</div>" +
                '<div class="stat-bars">' + card.bars.map(function (h) {
                    return '<span style="height:' + h + '%"></span>';
                }).join("") + "</div></div>";

        }).join("");

    }

    // Highlight the current page in the sidebar.
    function markActiveNav() {

        const wanted = /^reports/.test(PAGE) ? "goToReports()"
            : /^dashboard/.test(PAGE) ? "goToDashboard()"
            : null;

        document.querySelectorAll(".sidebar button, .inventory-sidebar button").forEach(function (button, index) {

            const handler = button.getAttribute("onclick") || "";

            const active = wanted
                ? handler.indexOf(wanted) !== -1
                : PAGE.indexOf("inventory") === 0 && index === 0;

            button.classList.toggle("is-active", active);

        });

    }

    function render() {

        if (!state.loaded.rooms || !state.loaded.reports) return;

        renderStats();
        renderRoomCards();
        renderReportRooms();
        renderInventoryPage();
        renderTeacherHistory();
        renderHeadReports();
        renderRoomBadges();
        renderHeadSummary();
        renderReportDetails();

    }


    /* =====================================================
       ACTIONS — REPORTS
    ===================================================== */

    function submitReport(event) {

        if (event) event.preventDefault();

        const form = byId("reportForm");

        return runAction("submit-report", async function () {

            if (!requireData()) return;

            const photoInput = byId("reportPhoto");
            const photoFile = photoInput && photoInput.files && photoInput.files[0];

            const photo = photoFile ? await readPhoto(photoFile) : "";

            const result = await store.addReport(Object.assign({
                roomNumber: getCurrentRoomNumber(),
                item: byId("reportItem").value,
                quantity: byId("reportQuantity").value,
                concern: byId("reportType").value,
                description: byId("reportDescription").value,
                photo: photo
            }, readReportExtras("report")), state.session);

            if (form) form.reset();

            notify("Defect report submitted successfully.", "success");

            return result;

        });

    }

    function verifyCurrentReport() {

        return runAction("verify-report", async function () {

            if (!requireData()) return;

            const report = currentReport();

            if (!report) {

                notify("No report selected.", "error");

                return;

            }

            await store.verifyReport(report.id, state.session);

            notify("Report verified. The room's defect count has been updated.", "success");

        });

    }

    function updateCurrentReportStatus(newStatus) {

        if (!newStatus) return;

        return runAction("report-status", async function () {

            if (!requireData()) return;

            const report = currentReport();

            if (!report) {

                notify("No report selected.", "error");

                return;

            }

            try {

                const result = await store.setReportStatus(
                    report.id, newStatus, state.session
                );

                if (result && result.changed) {
                    notify("Status updated to " + newStatus + ".", "success");
                }

            } catch (error) {

                // Put the dropdown back to the saved value.
                renderReportDetails();

                throw error;

            }

        });

    }


    /* =====================================================
       START-UP
    ===================================================== */

    // Hide anything marked data-role="x" from other roles.
    function applyRoleVisibility() {

        const role = state.session && state.session.role;

        document.querySelectorAll("[data-role]").forEach(function (element) {

            if (element.dataset.role !== role) element.style.display = "none";

        });

    }

    function handleSyncError(error) {

        notify(errorMessage(error), "error");

    }

    function startPage() {

        applyRoleVisibility();
        markActiveNav();
        setupReportExtras("report");

        store.subscribe({

            onRooms: function (rooms) {

                state.rooms = rooms;
                state.loaded.rooms = true;

                render();

            },

            onReports: function (reports) {

                state.reports = reports;
                state.loaded.reports = true;

                render();

            },

            onError: handleSyncError

        });

    }

    async function init() {

        const isLoginPage = Boolean(document.querySelector(".welcome-screen"));

        try {

            await store.ready();

            state.session = await store.getSession();

        } catch (error) {

            if (isLoginPage) {

                setText(
                    "modeNotice",
                    "Can't connect to Firebase. Check your internet connection and reload the page."
                );

            } else {

                notify(errorMessage(error), "error");

            }

            return;

        }

        if (isLoginPage) {

            initLoginPage();

            return;

        }

        const allowed = PAGE_ACCESS[PAGE];

        if (!state.session) {

            redirect("index.html");

            return;

        }

        if (allowed && allowed.indexOf(state.session.role) === -1) {

            redirect(HOME_BY_ROLE[state.session.role]);

            return;

        }

        startPage();

    }


    /* =====================================================
       PUBLIC HANDLERS
       Used by onclick / onsubmit / onchange attributes in the HTML.
    ===================================================== */

    Object.assign(window, {
        schoolHeadLogin: schoolHeadLogin,
        teacherAdviserLogin: teacherAdviserLogin,
        logout: logout,
        goToDashboard: goToDashboard,
        goToClassroom: goToClassroom,
        goToReports: goToReports,
        openInventory: openInventory,
        openReport: openReport,
        openReportById: openReportById,
        searchDashboard: searchDashboard,
        searchHeadDashboard: searchDashboard,
        enableInventoryEdit: enableInventoryEdit,
        saveInventoryChanges: saveInventoryChanges,
        saveInventory: saveInventory,
        changeRoomPhoto: changeRoomPhoto,
        submitReport: submitReport,
        openAddRoom: openAddRoom,
        closeAddRoom: closeAddRoom,
        submitAddRoom: submitAddRoom,
        openAddReport: openAddReport,
        closeAddReport: closeAddReport,
        submitAddReport: submitAddReport,
        fillReportItems: fillReportItems,
        verifyCurrentReport: verifyCurrentReport,
        updateCurrentReportStatus: updateCurrentReportStatus
    });

    // core is used only for display-side helpers if a page needs them.
    window.BuildSafe.ui = { notify: notify, core: core, ROLE_LABELS: ROLE_LABELS };

    document.addEventListener("DOMContentLoaded", init);

})();
