export interface MappedTestArguments {
  args: string[];
  requiresTestBuild: boolean;
}

export function isLogicalTestSelection(value: string): boolean;
export function mapCoverageValue(value: string): string;
export function mapLogicalTestSelection(value: string): string;
export function mapTestArguments(inputArgs: string[]): MappedTestArguments;
