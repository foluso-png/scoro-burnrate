// Canonical Campfire agency roles. Update this list as roles change.
// Shared between the /connect onboarding UI and Slack role-change handler.
export const CAMPFIRE_ROLES = [
  "Client Services Director",
  "Account Director",
  "Associate Account Director",
  "Senior Account Manager",
  "Account Manager",
  "Senior Account Executive",
  "Account Executive",
  "Strategy Director",
  "Strategy Manager",
  "Junior Strategist",
  "Creative Strategy Director",
  "Creative Strategy Lead",
  "Performance Creative Strategist",
  "Senior Creative Strategist",
  "Creative Strategist",
  "Engagement Director",
  "Senior Creator Marketing Manager",
  "Creator Marketing Manager",
  "Senior Creator Marketing Executive",
  "Creator Marketing Executive",
  "Senior Social Media Manager",
  "Senior Social Media Executive",
  "Social Media Executive",
  "Paid Social Manager",
  "Project Lead",
  "Senior Project Manager",
  "Project Manager",
  "Project Co-ordinator",
] as const;

export type CampfireRole = (typeof CAMPFIRE_ROLES)[number];
