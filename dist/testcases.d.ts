export interface TestCaseStep {
    action: string;
    expected: string;
}
export interface TestCaseMeta {
    id: string;
    name: string;
    platform: string;
    priority: string;
    tags: string[];
    author: string;
    created_at: string;
    linked_feature?: string;
    last_run_status?: string;
    description: string;
    preconditions?: string[];
    steps: TestCaseStep[];
}
/**
 * Parse YAML content into a TestCaseMeta object.
 * Throws if YAML is malformed or required fields are missing.
 */
export declare function parseTestCase(yamlContent: string): TestCaseMeta;
/**
 * Validate a parsed TestCaseMeta object.
 * Returns an error message string if invalid, or null if valid.
 */
export declare function validateTestCase(tc: TestCaseMeta): string | null;
/**
 * Scan a directory for YAML test case files, parse their metadata.
 * Optionally filter by platform.
 */
export declare function listTestCases(dirPath: string, platformFilter?: string): TestCaseMeta[];
/**
 * Validate YAML content and write to file. Returns full path.
 */
export declare function saveTestCase(dirPath: string, filename: string, content: string): string;
/**
 * Read a test case file and return raw content + parsed metadata.
 */
export declare function readTestCase(filePath: string): {
    content: string;
    parsed: TestCaseMeta;
};
/**
 * Delete a test case file.
 */
export declare function deleteTestCase(filePath: string): void;
//# sourceMappingURL=testcases.d.ts.map