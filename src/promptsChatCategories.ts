export const PROMPTS_CHAT_PUBLIC_CATEGORIES = [
  { category: "coding", keywords: ["coding"] },
  { category: "sponsors", keywords: ["github sponsors profile"] },
  { category: "agent-skill", keywords: ["agent skill"] },
  { category: "vibe-coding", keywords: ["vibe coding"] },
  { category: "web-development", keywords: ["web development"] },
  { category: "mobile-development", keywords: ["mobile development"] },
  { category: "devops", keywords: ["devops"] },
  { category: "data-science", keywords: ["data science"] },
  { category: "writing", keywords: ["writing"] },
  { category: "blog-writing", keywords: ["blog writing"] },
  { category: "copywriting", keywords: ["copywriting"] },
  { category: "technical-writing", keywords: ["technical writing"] },
  { category: "business", keywords: ["business"] },
  { category: "marketing", keywords: ["marketing"] },
  { category: "sales", keywords: ["sales"] },
  { category: "hr-recruiting", keywords: ["hr recruiting"] },
  { category: "creative", keywords: ["creative"] },
  { category: "design", keywords: ["design"] },
  { category: "video-generation", keywords: ["video generation"] },
  { category: "image-generation", keywords: ["image generation"] },
  { category: "music", keywords: ["music"] },
  { category: "education", keywords: ["education"] },
  { category: "teaching-instruction", keywords: ["teaching instruction"] },
  { category: "tutoring-homework-help", keywords: ["tutoring homework help"] },
  { category: "exam-preparation", keywords: ["exam preparation"] },
  { category: "language-learning", keywords: ["language learning"] },
  { category: "academic-writing", keywords: ["academic writing"] },
  { category: "stem-science", keywords: ["stem science"] },
  { category: "course-creation", keywords: ["course creation"] },
  { category: "kids-early-learning", keywords: ["kids early learning"] },
  { category: "workflows", keywords: ["workflows"] },
  { category: "agent-workflows", keywords: ["agent workflows"] },
  { category: "automations", keywords: ["automations"] },
  { category: "productivity", keywords: ["productivity"] },
  { category: "time-management", keywords: ["time management"] },
  { category: "note-taking", keywords: ["note taking"] },
  { category: "email-communication", keywords: ["email communication"] },
  { category: "meeting-collaboration", keywords: ["meeting collaboration"] },
  { category: "automation-workflows", keywords: ["automation workflows"] },
  { category: "research-analysis", keywords: ["research analysis"] },
  { category: "self-improvement", keywords: ["self improvement"] },
  { category: "habits-routines", keywords: ["habits routines"] },
  { category: "mindset-motivation", keywords: ["mindset motivation"] },
  { category: "learning-skills", keywords: ["learning skills"] },
  { category: "health-wellness", keywords: ["health wellness"] },
  { category: "goal-setting", keywords: ["goal setting"] },
  { category: "journaling-reflection", keywords: ["journaling reflection"] },
  { category: "business-strategy", keywords: ["business strategy"] },
  { category: "business-planning", keywords: ["business planning"] },
  { category: "market-analysis", keywords: ["market analysis"] },
  { category: "finance-budgeting", keywords: ["finance budgeting"] },
  { category: "marketing-sales", keywords: ["marketing sales"] },
  { category: "leadership-management", keywords: ["leadership management"] },
  { category: "startup-entrepreneurship", keywords: ["startup entrepreneurship"] },
] as const;

export type PromptsChatCategoryConfig = {
  category: string;
  keywords: readonly string[];
};

export const PROMPTS_CHAT_CATEGORY_SLUGS: ReadonlySet<string> = new Set(
  PROMPTS_CHAT_PUBLIC_CATEGORIES.map((item) => item.category)
);

export const PROMPTS_CHAT_CATEGORY_PRESETS: Record<string, string[]> = {
  developer: [
    "coding",
    "web-development",
    "devops",
    "data-science",
    "technical-writing",
    "agent-workflows",
  ],
  writer: [
    "writing",
    "blog-writing",
    "copywriting",
    "technical-writing",
    "email-communication",
    "academic-writing",
  ],
  business: [
    "business",
    "business-strategy",
    "business-planning",
    "market-analysis",
    "marketing-sales",
    "leadership-management",
    "startup-entrepreneurship",
  ],
  creative: [
    "creative",
    "design",
    "image-generation",
    "video-generation",
    "music",
    "copywriting",
  ],
  productivity: [
    "productivity",
    "time-management",
    "note-taking",
    "meeting-collaboration",
    "email-communication",
    "automation-workflows",
  ],
  all: PROMPTS_CHAT_PUBLIC_CATEGORIES.map((item) => item.category),
};

export function validatePromptsChatCategories(categories: string[]): string[] {
  return categories.filter((category) => !PROMPTS_CHAT_CATEGORY_SLUGS.has(category));
}
