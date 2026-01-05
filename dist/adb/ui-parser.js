/**
 * Parse UI hierarchy XML from uiautomator dump
 */
export function parseUiHierarchy(xml) {
    const elements = [];
    const nodeRegex = /<node[^>]+>/g;
    let match;
    let index = 0;
    while ((match = nodeRegex.exec(xml)) !== null) {
        const nodeStr = match[0];
        // Parse bounds
        const boundsMatch = nodeStr.match(/bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/);
        if (!boundsMatch)
            continue;
        const bounds = {
            x1: parseInt(boundsMatch[1]),
            y1: parseInt(boundsMatch[2]),
            x2: parseInt(boundsMatch[3]),
            y2: parseInt(boundsMatch[4])
        };
        const element = {
            index: index++,
            resourceId: extractAttr(nodeStr, "resource-id"),
            className: extractAttr(nodeStr, "class"),
            packageName: extractAttr(nodeStr, "package"),
            text: extractAttr(nodeStr, "text"),
            contentDesc: extractAttr(nodeStr, "content-desc"),
            checkable: extractAttr(nodeStr, "checkable") === "true",
            checked: extractAttr(nodeStr, "checked") === "true",
            clickable: extractAttr(nodeStr, "clickable") === "true",
            enabled: extractAttr(nodeStr, "enabled") === "true",
            focusable: extractAttr(nodeStr, "focusable") === "true",
            focused: extractAttr(nodeStr, "focused") === "true",
            scrollable: extractAttr(nodeStr, "scrollable") === "true",
            longClickable: extractAttr(nodeStr, "long-clickable") === "true",
            password: extractAttr(nodeStr, "password") === "true",
            selected: extractAttr(nodeStr, "selected") === "true",
            bounds,
            centerX: Math.floor((bounds.x1 + bounds.x2) / 2),
            centerY: Math.floor((bounds.y1 + bounds.y2) / 2),
            width: bounds.x2 - bounds.x1,
            height: bounds.y2 - bounds.y1
        };
        elements.push(element);
    }
    return elements;
}
/**
 * Extract attribute value from node string
 */
function extractAttr(nodeStr, attrName) {
    const regex = new RegExp(`${attrName}="([^"]*)"`);
    const match = nodeStr.match(regex);
    return match?.[1] ?? "";
}
/**
 * Find elements by text (partial match, case-insensitive)
 */
export function findByText(elements, text) {
    const lowerText = text.toLowerCase();
    return elements.filter(el => el.text.toLowerCase().includes(lowerText) ||
        el.contentDesc.toLowerCase().includes(lowerText));
}
/**
 * Find elements by resource ID (partial match)
 */
export function findByResourceId(elements, id) {
    return elements.filter(el => el.resourceId.includes(id));
}
/**
 * Find elements by class name
 */
export function findByClassName(elements, className) {
    return elements.filter(el => el.className.includes(className));
}
/**
 * Find clickable elements
 */
export function findClickable(elements) {
    return elements.filter(el => el.clickable);
}
/**
 * Find elements by multiple criteria
 */
export function findElements(elements, criteria) {
    return elements.filter(el => {
        if (criteria.text && !el.text.toLowerCase().includes(criteria.text.toLowerCase()) &&
            !el.contentDesc.toLowerCase().includes(criteria.text.toLowerCase())) {
            return false;
        }
        if (criteria.resourceId && !el.resourceId.includes(criteria.resourceId)) {
            return false;
        }
        if (criteria.className && !el.className.includes(criteria.className)) {
            return false;
        }
        if (criteria.clickable !== undefined && el.clickable !== criteria.clickable) {
            return false;
        }
        if (criteria.enabled !== undefined && el.enabled !== criteria.enabled) {
            return false;
        }
        if (criteria.visible !== undefined) {
            const isVisible = el.width > 0 && el.height > 0;
            if (isVisible !== criteria.visible)
                return false;
        }
        return true;
    });
}
/**
 * Format element for display
 */
export function formatElement(el) {
    const parts = [];
    const shortClass = el.className.split(".").pop() ?? el.className;
    parts.push(`[${el.index}]`);
    parts.push(`<${shortClass}>`);
    if (el.resourceId) {
        const shortId = el.resourceId.split(":id/").pop() ?? el.resourceId;
        parts.push(`id="${shortId}"`);
    }
    if (el.text) {
        parts.push(`text="${el.text.slice(0, 50)}${el.text.length > 50 ? "..." : ""}"`);
    }
    if (el.contentDesc) {
        parts.push(`desc="${el.contentDesc.slice(0, 30)}${el.contentDesc.length > 30 ? "..." : ""}"`);
    }
    const flags = [];
    if (el.clickable)
        flags.push("clickable");
    if (el.scrollable)
        flags.push("scrollable");
    if (el.focused)
        flags.push("focused");
    if (el.checked)
        flags.push("checked");
    if (!el.enabled)
        flags.push("disabled");
    if (flags.length > 0) {
        parts.push(`(${flags.join(", ")})`);
    }
    parts.push(`@ (${el.centerX}, ${el.centerY})`);
    return parts.join(" ");
}
/**
 * Format UI tree for display (simplified view)
 */
export function formatUiTree(elements, options) {
    const { showAll = false, maxElements = 100 } = options ?? {};
    // Filter to only meaningful elements
    let filtered = showAll
        ? elements
        : elements.filter(el => el.text ||
            el.contentDesc ||
            el.clickable ||
            el.scrollable ||
            el.focusable ||
            el.resourceId.includes(":id/"));
    if (filtered.length > maxElements) {
        filtered = filtered.slice(0, maxElements);
    }
    if (filtered.length === 0) {
        return "No UI elements found";
    }
    return filtered.map(formatElement).join("\n");
}
//# sourceMappingURL=ui-parser.js.map