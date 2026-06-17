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
    coordinates: { x: number; y: number };
  }>;
  /** Text input fields */
  inputs: Array<{
    index: number;
    hint: string;
    value: string;
    coordinates: { x: number; y: number };
  }>;
  /** Static text on screen */
  texts: Array<{
    content: string;
    coordinates: { x: number; y: number };
  }>;
  /** Scrollable containers */
  scrollable: Array<{
    index: number;
    direction: "vertical" | "horizontal" | "both";
    coordinates: { x: number; y: number };
  }>;
  /** Summary for quick understanding */
  summary: string;
}

export interface UiDiffResult {
  screenChanged: boolean;
  appeared: string[];
  disappeared: string[];
  beforeCount: number;
  afterCount: number;
}

/**
 * Get short ID from resource ID
 */
export function getShortId(resourceId: string): string {
  if (!resourceId) return "";
  return resourceId.split(":id/").pop() ?? resourceId;
}
