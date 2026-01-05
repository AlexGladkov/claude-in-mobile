export interface Bounds {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}
export interface UiElement {
    index: number;
    resourceId: string;
    className: string;
    packageName: string;
    text: string;
    contentDesc: string;
    checkable: boolean;
    checked: boolean;
    clickable: boolean;
    enabled: boolean;
    focusable: boolean;
    focused: boolean;
    scrollable: boolean;
    longClickable: boolean;
    password: boolean;
    selected: boolean;
    bounds: Bounds;
    centerX: number;
    centerY: number;
    width: number;
    height: number;
}
/**
 * Parse UI hierarchy XML from uiautomator dump
 */
export declare function parseUiHierarchy(xml: string): UiElement[];
/**
 * Find elements by text (partial match, case-insensitive)
 */
export declare function findByText(elements: UiElement[], text: string): UiElement[];
/**
 * Find elements by resource ID (partial match)
 */
export declare function findByResourceId(elements: UiElement[], id: string): UiElement[];
/**
 * Find elements by class name
 */
export declare function findByClassName(elements: UiElement[], className: string): UiElement[];
/**
 * Find clickable elements
 */
export declare function findClickable(elements: UiElement[]): UiElement[];
/**
 * Find elements by multiple criteria
 */
export declare function findElements(elements: UiElement[], criteria: {
    text?: string;
    resourceId?: string;
    className?: string;
    clickable?: boolean;
    enabled?: boolean;
    visible?: boolean;
}): UiElement[];
/**
 * Format element for display
 */
export declare function formatElement(el: UiElement): string;
/**
 * Format UI tree for display (simplified view)
 */
export declare function formatUiTree(elements: UiElement[], options?: {
    showAll?: boolean;
    maxElements?: number;
}): string;
//# sourceMappingURL=ui-parser.d.ts.map