/**
 * Shared TypeScript types for test generation
 */

export interface ServiceInfo {
  role: 'frontend' | 'backend' | 'fullstack'
  path?: string
  port?: number
  baseURL?: string
  startCommand?: string | null
  framework?: string
  portConflictResolved?: boolean
}

export interface ProjectInfo {
  name?: string
  baseURL?: string
  framework?: string
  startCommand?: string
  // When the repo splits frontend + backend (monorepo) these describe each service
  // individually so generated tests can target the right port and generated
  // Playwright projects can launch each with its own `startCommand` / `baseURL`.
  services?: ServiceInfo[]
  // True when every detected service is a backend. Generator switches into
  // multi-step API-flow mode (chained calls: api1 → api2 → api3) with no
  // frontend/UI test output.
  apiOnly?: boolean
  testCredentials?: Array<{ role?: string; username?: string; password?: string }>
}

export interface PageInfo {
  path: string
  description?: string
  components?: string[]
  interactions?: string[]
  selectorHints?: string[]
}

export interface ApiEndpoint {
  method: string
  path: string
  requiresAuth?: boolean
  authRequired?: boolean
  auth?: string
  requestBody?: unknown
  requestSchema?: Record<string, unknown>
  responseSchema?: Record<string, unknown>
  responseShape?: unknown
  expectedStatus?: number
  expectedStatuses?: number[]
  successStatus?: number
  successStatuses?: number[]
  status?: number
  statuses?: number[]
  description?: string
  errorScenarios?: string[]
}

export interface WorkflowInfo {
  name: string
  description?: string
  steps?: string[]
  criticalAssertions?: string[]
  source?: string
}

export interface FormField {
  name: string
  type: string
  required?: boolean
  label?: string | null
  placeholder?: string | null
  testId?: string | null
  ariaLabel?: string | null
  id?: string | null
  role?: string
}

export interface FormInfo {
  file: string
  fields: FormField[]
  validationPatterns: string[]
  hasFormElement: boolean
  usesFormHook: boolean
  labels: string[]
  submitButtons: Array<{ text: string; type: string; testId?: string | null; ariaLabel?: string | null }>
  action?: string | null
  method?: string | null
  selectorHints: string[]
}

export interface ComponentInfo {
  name: string
  file: string
  props: Array<{ name: string; optional: boolean; type: string }>
  stateHooks: Array<{ initialValue: string }>
  eventHandlers: string[]
  hasUseEffect: boolean
  hasUseRef: boolean
  usesRouter: boolean
}

export interface AuthPattern {
  type: string
  description: string
}

export interface MockableApiContract {
  method: string
  path: string
  request?: { fields?: string[] }
  responses?: number[]
}

export interface NavigationGraph {
  nodes?: string[]
  edges?: string[]
}

export interface CapturedContext {
  pages?: PageInfo[]
  apiEndpoints?: ApiEndpoint[]
  workflows?: (WorkflowInfo | string)[]
  forms?: FormInfo[]
  authPatterns?: AuthPattern[]
  apiSchemas?: Array<{ name: string; type: string; file: string; fields?: unknown[] }>
  componentDetails?: ComponentInfo[]
  navigationGraph?: NavigationGraph
  selectorHints?: string[]
  mockableApiContracts?: MockableApiContract[]
  dataModels?: unknown[]
  fileContents?: Record<string, string>
  envVariables?: string[]
  dependencies?: Record<string, unknown>
  errorScenarios?: Array<{ scenario: string; trigger: string; expectedError: string }>
  criticalBusinessLogic?: unknown[]
  frontendInteractions?: unknown[]
  testDataSuggestions?: unknown
  projectStructure?: {
    framework?: string
    hasTypeScript?: boolean
    directories?: string[]
  }
}

export interface GenerationOptions {
  includeSmoke?: boolean
  includeWorkflows?: boolean
  includeErrorStates?: boolean
  strictAIGeneration?: boolean
  minGeneratedTests?: number
  coverageProfile?: 'balanced' | 'qa-max' | 'exhaustive'
  maxExpansionAttempts?: number
}

export interface GeneratedTestFile {
  filename: string
  content: string
  type: string
  source?: string
  fallbackReason?: string | null
  attempt?: number | null
}

export interface GenerationAttempt {
  prefix?: string
  generator?: string
  attempt?: number
  status: 'success' | 'failed' | 'skipped'
  parseMode?: string
  generated?: number
  reason?: string
  durationMs?: number
}

export interface GenerationQuality {
  valid: boolean
  errorCode: string | null
  errors: string[]
  totalTests: number
  minGeneratedTests: number
  coverageProfile: string
  minCategoryHits: number
  requiredCategories: string[]
  missingCategories: string[]
  categories: Record<string, number>
}

export interface GenerationMeta {
  provider: string | null
  testType: string
  attempts: GenerationAttempt[]
  rejections: Array<{
    filename: string
    prefix: string
    qualityErrors: string[]
    syntaxErrors: string[]
  }>
  parseModes: string[]
  fallbackReason: string | null
  fallbackTypes: string[]
  startedAt: string
  finishedAt: string | null
  generationQuality?: GenerationQuality
  // Populated when one or more agents in the parallel fan-out reject with an
  // unexpected error (rather than simply returning 0 tests). Mirrored to the
  // MCP so it can land a partialGenerationWarning on the dashboard.
  agentFailures?: Array<{
    agent: AgentName | 'unknown'
    code: string | null
    message: string
  }>
}

export type AcceptanceCriterionKind = 'positive' | 'negative' | 'boundary'

export interface AcceptanceCriterion {
  id: string                  // e.g. "F1.S1.AC1"
  kind: AcceptanceCriterionKind
  authRequired: boolean
  roleHint?: string           // e.g. "admin" if the AC is admin-only
  text: string                // original AC language, preserved verbatim
}

export interface UserStory {
  id: string                  // e.g. "F1.S1"
  persona: string
  goal: string
  acceptanceCriteria: AcceptanceCriterion[]
}

export interface PRDFeature {
  id: string                  // e.g. "F1"
  name: string
  userStories: UserStory[]
}

export interface PRDPersona {
  name: string
  description: string
}

export interface NonFunctionalRequirement {
  kind: 'perf' | 'a11y' | 'i18n' | 'security'
  text: string
}

export interface ParsedPRD {
  features: PRDFeature[]
  personas: PRDPersona[]
  nonFunctional: NonFunctionalRequirement[]
  sourceHash?: string          // SHA-256 of the raw PRD text; used as cache key
  parsedAt?: string            // ISO timestamp
}

export interface Role {
  name: string                 // e.g. "admin", "user"
  role?: string                // MCP compatibility: older runners send role instead of name
  storageStatePath?: string    // path to Playwright storageState JSON for this role
  loginVerified?: boolean
}

export interface ObservedLabel {
  text: string
  for: string | null
}

export interface ObservedSelectOption {
  text: string
  value: string
}

export interface ObservedSelect {
  name: string
  options: ObservedSelectOption[]
}

export interface ObservedButton {
  text: string
  disabled: boolean
  ariaLabel: string | null
}

export interface ObservedHeading {
  level: number
  text: string
}

export interface ErrorProbe {
  h1: string | null
  firstP: string | null
}

export interface ObservedRoute {
  path: string
  requiresAuth: boolean
  elements: Array<{ role: string; name: string; selector: string }>
  labels?: ObservedLabel[]
  selectOptions?: ObservedSelect[]
  buttons?: ObservedButton[]
  headings?: ObservedHeading[]
}

export interface ObservedForm {
  route: string
  fields: Array<{ name: string; type: string; required: boolean }>
  submitLabel: string
}

export interface ObservedAuthFlow {
  loginUrl: string
  credentialFields: { username: string; password: string }
  successIndicator: string
  failureIndicator: string
}

export interface ObservedKeyFlow {
  name: string
  steps: Array<{ action: string; target: string; value?: string }>
  endCondition: string
}

export interface ExplorationArtifact {
  routes: ObservedRoute[]
  forms: ObservedForm[]
  authFlow: ObservedAuthFlow | null
  keyFlows: ObservedKeyFlow[]
  observedErrors: string[]
  errorProbe?: ErrorProbe | null
}

export type AgentName = 'smoke' | 'frontend' | 'api' | 'workflow' | 'error' | 'expansion'

export interface AgentRunRecord {
  agent: AgentName
  startedAt: string
  finishedAt: string
  latencyMs: number
  success: boolean
  testsProduced: number
  modelUsed: string | null
  tokensPrompt: number
  tokensCompletion: number
  tokensTotal: number
  errorCode?: string | null
  errorMessage?: string | null
}

export type AgentCompleteHook = (record: AgentRunRecord) => void | Promise<void>

export interface GenerateTestsParams {
  context?: CapturedContext
  prd?: string
  parsedPRD?: ParsedPRD | null
  explorationArtifact?: ExplorationArtifact | null
  roles?: Role[]
  testType?: 'frontend' | 'backend' | 'both'
  projectInfo?: ProjectInfo
  options?: GenerationOptions
  onAgentComplete?: AgentCompleteHook
  // When set, only agents whose name is in the set are run. Undefined means
  // "run the full rule-based plan" (legacy behavior). The MCP sets this to
  // `new Set(['smoke'])` etc. to chunk generation across 5 parallel HTTP calls
  // so each call fits under Vercel Hobby's 60s ceiling.
  agentsAllowlist?: Set<AgentName>
  // P1.5 — per-agent plan slice. When present, each generate*Tests method
  // prepends an "ONLY generate tests for these targets: {slice}" preamble to
  // the prompt so the agent's output is scoped to the planner's decisions.
  agentPlanSlice?: Record<string, unknown>
}

export interface OpenAIClientConfig {
  apiKey: string
  model?: string
  chatFallbackModel?: string
  latestGPTModel?: string
  modelFallbacks?: string[]
  maxTokens?: number
  temperature?: number
  timeout?: number
  reasoningEffort?: 'low' | 'medium' | 'high'
}

export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface OpenAIUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

export interface OpenAICallResult {
  text: string
  usage: OpenAIUsage
  modelUsed: string
}
