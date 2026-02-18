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
/**
 * Screen analysis result
 */
export interface ScreenAnalysis {
    /** Current activity/screen name */
    activity?: string;
    /** Detected screen title (from Toolbar/NavigationBar) */
    screenTitle?: string;
    /** Whether a dialog/modal is detected */
    hasDialog?: boolean;
    /** Dialog title if detected */
    dialogTitle?: string;
    /** Navigation state */
    navigationState?: {
        hasBack: boolean;
        hasMenu: boolean;
        hasTabs: boolean;
        currentTab?: string;
    };
    /** Buttons and clickable elements */
    buttons: Array<{
        index: number;
        label: string;
        coordinates: {
            x: number;
            y: number;
        };
    }>;
    /** Text input fields */
    inputs: Array<{
        index: number;
        hint: string;
        value: string;
        coordinates: {
            x: number;
            y: number;
        };
    }>;
    /** Static text on screen */
    texts: Array<{
        content: string;
        coordinates: {
            x: number;
            y: number;
        };
    }>;
    /** Scrollable containers */
    scrollable: Array<{
        index: number;
        direction: "vertical" | "horizontal" | "both";
        coordinates: {
            x: number;
            y: number;
        };
    }>;
    /** Summary for quick understanding */
    summary: string;
}
/**
 * Detect screen title from Toolbar/ActionBar/NavigationBar elements
 */
export declare function detectScreenTitle(elements: UiElement[]): string | undefined;
/**
 * Detect if a dialog/modal is present and return its title
 */
export declare function detectDialog(elements: UiElement[]): {
    hasDialog: boolean;
    dialogTitle?: string;
};
/**
 * Detect navigation state (back button, menu, tabs)
 */
export declare function detectNavigation(elements: UiElement[]): {
    hasBack: boolean;
    hasMenu: boolean;
    hasTabs: boolean;
    currentTab?: string;
};
/**
 * Convert desktop UI hierarchy text to UiElement[] for cross-platform analysis.
 * Desktop hierarchy is pre-formatted text from the companion app.
 * Format: indented lines like "  <Button> text="Click me" @ (100, 200) [50x30]"
 */
export declare function desktopHierarchyToUiElements(hierarchyText: string): UiElement[];
/**
 * Analyze screen and return structured information
 * More useful than raw UI tree for Claude to understand
 */
export declare function analyzeScreen(elements: UiElement[], activity?: string): ScreenAnalysis;
/**
 * Find best element by description (smart fuzzy search)
 * Returns the best match or null
 */
export declare function findBestMatch(elements: UiElement[], description: string): {
    element: UiElement;
    confidence: number;
    reason: string;
} | null;
/**
 * Format screen analysis as text
 */
export declare function formatScreenAnalysis(analysis: ScreenAnalysis): string;
export interface UiDiffResult {
    screenChanged: boolean;
    appeared: string[];
    disappeared: string[];
    beforeCount: number;
    afterCount: number;
}
/**
 * Diff two sets of UI elements to detect changes.
 * Returns appeared/disappeared element descriptions and whether the screen changed significantly.
 */
export declare function diffUiElements(before: UiElement[], after: UiElement[]): UiDiffResult;
/**
 * Suggest next actions based on current UI state.
 */
export declare function suggestNextActions(elements: UiElement[]): string[];
//# sourceMappingURL=ui-parser.d.ts.map