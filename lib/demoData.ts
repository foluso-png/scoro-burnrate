import type { ProjectData } from "./scoro";

const PROJECT_ID = 1001;

function generateTimeEntries() {
  const people = [
    { user_id: 1, user_name: "Sarah Chen", cost_rate: 85 },
    { user_id: 2, user_name: "James Wilson", cost_rate: 75 },
    { user_id: 3, user_name: "Maria Garcia", cost_rate: 95 },
    { user_id: 4, user_name: "Tom Baker", cost_rate: 65 },
    { user_id: 5, user_name: "Priya Patel", cost_rate: 80 },
  ];

  const tasks = [
    { activity_id: 101, activity_name: "Discovery & Research" },
    { activity_id: 102, activity_name: "UX Design" },
    { activity_id: 103, activity_name: "Frontend Development" },
    { activity_id: 104, activity_name: "Backend Development" },
    { activity_id: 105, activity_name: "Content Migration" },
    { activity_id: 106, activity_name: "QA & Testing" },
    { activity_id: 107, activity_name: "Project Management" },
    { activity_id: 108, activity_name: "DevOps & Deployment" },
  ];

  // Hours per task per person per month (sparse)
  // Designed to create a mix of green/amber/red burn rates
  const plan: {
    month: string;
    taskIdx: number;
    personIdx: number;
    hours: number;
  }[] = [
    // Month 1 - Oct 2025: Discovery phase
    { month: "2025-10", taskIdx: 0, personIdx: 0, hours: 16 },
    { month: "2025-10", taskIdx: 0, personIdx: 2, hours: 12 },
    { month: "2025-10", taskIdx: 6, personIdx: 4, hours: 10 },
    { month: "2025-10", taskIdx: 1, personIdx: 0, hours: 8 },

    // Month 2 - Nov 2025: Design ramps up
    { month: "2025-11", taskIdx: 1, personIdx: 0, hours: 28 },
    { month: "2025-11", taskIdx: 1, personIdx: 2, hours: 20 },
    { month: "2025-11", taskIdx: 0, personIdx: 0, hours: 6 },
    { month: "2025-11", taskIdx: 6, personIdx: 4, hours: 12 },
    { month: "2025-11", taskIdx: 2, personIdx: 1, hours: 8 },

    // Month 3 - Dec 2025: Development starts
    { month: "2025-12", taskIdx: 2, personIdx: 1, hours: 32 },
    { month: "2025-12", taskIdx: 3, personIdx: 2, hours: 36 },
    { month: "2025-12", taskIdx: 1, personIdx: 0, hours: 12 },
    { month: "2025-12", taskIdx: 6, personIdx: 4, hours: 10 },
    { month: "2025-12", taskIdx: 4, personIdx: 3, hours: 8 },

    // Month 4 - Jan 2026: Heavy development
    { month: "2026-01", taskIdx: 2, personIdx: 1, hours: 40 },
    { month: "2026-01", taskIdx: 2, personIdx: 0, hours: 16 },
    { month: "2026-01", taskIdx: 3, personIdx: 2, hours: 44 },
    { month: "2026-01", taskIdx: 4, personIdx: 3, hours: 24 },
    { month: "2026-01", taskIdx: 6, personIdx: 4, hours: 14 },
    { month: "2026-01", taskIdx: 7, personIdx: 1, hours: 8 },

    // Month 5 - Feb 2026: Testing & migration ramp
    { month: "2026-02", taskIdx: 2, personIdx: 1, hours: 24 },
    { month: "2026-02", taskIdx: 3, personIdx: 2, hours: 20 },
    { month: "2026-02", taskIdx: 4, personIdx: 3, hours: 32 },
    { month: "2026-02", taskIdx: 5, personIdx: 4, hours: 28 },
    { month: "2026-02", taskIdx: 5, personIdx: 0, hours: 12 },
    { month: "2026-02", taskIdx: 6, personIdx: 4, hours: 10 },
    { month: "2026-02", taskIdx: 7, personIdx: 1, hours: 12 },

    // Month 6 - Mar 2026: Final push, over budget on some tasks
    { month: "2026-03", taskIdx: 4, personIdx: 3, hours: 28 },
    { month: "2026-03", taskIdx: 5, personIdx: 4, hours: 20 },
    { month: "2026-03", taskIdx: 5, personIdx: 0, hours: 16 },
    { month: "2026-03", taskIdx: 7, personIdx: 1, hours: 16 },
    { month: "2026-03", taskIdx: 6, personIdx: 4, hours: 8 },
    { month: "2026-03", taskIdx: 2, personIdx: 1, hours: 12 },
    { month: "2026-03", taskIdx: 3, personIdx: 2, hours: 8 },
  ];

  let entryId = 1;
  return plan.map((p) => {
    const person = people[p.personIdx];
    const task = tasks[p.taskIdx];
    const day = String(Math.floor(Math.random() * 20) + 5).padStart(2, "0");
    return {
      event_id: entryId++,
      activity_id: task.activity_id,
      activity_name: task.activity_name,
      user_id: person.user_id,
      user_name: person.user_name,
      duration: p.hours,
      date: `${p.month}-${day}`,
      project_id: PROJECT_ID,
      bill_rate: person.cost_rate * 1.4,
      cost_rate: person.cost_rate,
      description: `${task.activity_name} work`,
    };
  });
}

export const demoProjectData: ProjectData = {
  project: {
    project_id: PROJECT_ID,
    project_name: "Website Redesign",
    company_name: "Acme Corp",
    start_date: "2025-10-01",
    end_date: "2026-03-31",
    status: "in_progress",
    budget: 85000,
    description: "Complete website redesign and migration for Acme Corp",
  },
  timeEntries: generateTimeEntries(),
  quotes: [
    {
      quote_id: 501,
      no: "Q-2025-042",
      sum: 85000,
      project_id: PROJECT_ID,
      lines: [
        {
          product_name: "Discovery & Research",
          comment: "Discovery & Research",
          amount: 30,
          price: 120,
          sum: 3600,
        },
        {
          product_name: "UX Design",
          comment: "UX Design",
          amount: 60,
          price: 120,
          sum: 7200,
        },
        {
          product_name: "Frontend Development",
          comment: "Frontend Development",
          amount: 100,
          price: 110,
          sum: 11000,
        },
        {
          product_name: "Backend Development",
          comment: "Backend Development",
          amount: 80,
          price: 130,
          sum: 10400,
        },
        {
          product_name: "Content Migration",
          comment: "Content Migration",
          amount: 60,
          price: 90,
          sum: 5400,
        },
        {
          product_name: "QA & Testing",
          comment: "QA & Testing",
          amount: 50,
          price: 100,
          sum: 5000,
        },
        {
          product_name: "Project Management",
          comment: "Project Management",
          amount: 80,
          price: 110,
          sum: 8800,
        },
        {
          product_name: "DevOps & Deployment",
          comment: "DevOps & Deployment",
          amount: 30,
          price: 120,
          sum: 3600,
        },
      ],
    },
  ],
  invoices: [
    {
      invoice_id: 701,
      no: "INV-2025-118",
      sum: 25000,
      date: "2025-11-30",
      project_id: PROJECT_ID,
    },
    {
      invoice_id: 702,
      no: "INV-2026-012",
      sum: 30000,
      date: "2026-01-31",
      project_id: PROJECT_ID,
    },
    {
      invoice_id: 703,
      no: "INV-2026-038",
      sum: 20000,
      date: "2026-03-15",
      project_id: PROJECT_ID,
    },
  ],
  tasks: [
    {
      task_id: 101,
      activity_id: 101,
      event_name: "Discovery & Research",
      project_id: PROJECT_ID,
      status: "completed",
      estimated_hours: 30,
    },
    {
      task_id: 102,
      activity_id: 102,
      event_name: "UX Design",
      project_id: PROJECT_ID,
      status: "completed",
      estimated_hours: 60,
    },
    {
      task_id: 103,
      activity_id: 103,
      event_name: "Frontend Development",
      project_id: PROJECT_ID,
      status: "in_progress",
      estimated_hours: 100,
    },
    {
      task_id: 104,
      activity_id: 104,
      event_name: "Backend Development",
      project_id: PROJECT_ID,
      status: "in_progress",
      estimated_hours: 80,
    },
    {
      task_id: 105,
      activity_id: 105,
      event_name: "Content Migration",
      project_id: PROJECT_ID,
      status: "in_progress",
      estimated_hours: 60,
    },
    {
      task_id: 106,
      activity_id: 106,
      event_name: "QA & Testing",
      project_id: PROJECT_ID,
      status: "in_progress",
      estimated_hours: 50,
    },
    {
      task_id: 107,
      activity_id: 107,
      event_name: "Project Management",
      project_id: PROJECT_ID,
      status: "in_progress",
      estimated_hours: 80,
    },
    {
      task_id: 108,
      activity_id: 108,
      event_name: "DevOps & Deployment",
      project_id: PROJECT_ID,
      status: "not_started",
      estimated_hours: 30,
    },
  ],
};

export const demoProjects = [
  {
    project_id: PROJECT_ID,
    project_name: "Website Redesign",
    company_name: "Acme Corp",
    start_date: "2025-10-01",
    end_date: "2026-03-31",
    status: "in_progress",
  },
];
