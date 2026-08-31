/**
 * Skill-name equivalence groups, for matching a JD keyword against a resume
 * that says the same thing differently.
 *
 * WHAT "SYNONYM" MEANS HERE
 * ------------------------
 * These groups are deliberately looser than true synonymy. They mix two
 * relations that both earn *partial* credit in the gap analysis, never full:
 *
 *   aliases   -- the same thing spelled differently. K8s / Kubernetes,
 *                Postgres / PostgreSQL, ReactJS / React.
 *   neighbours -- not the same thing, but one strongly implies familiarity
 *                with the other. TypeScript / JavaScript, GitHub Actions /
 *                Jenkins, both of which sit under CI/CD.
 *
 * Collapsing both into one equivalence class is the point, not sloppiness: a
 * JD asking for Jenkins is substantially satisfied by a resume showing GitHub
 * Actions, and the gap analyser scores that at 0.6 rather than 1.0 precisely
 * because it is not an exact match. If you need strict aliasing later, split
 * the groups then -- do not tighten these in place, because the 0.6 weight
 * downstream is calibrated against this looseness.
 *
 * Membership is transitive within a group. Adding a term to a group makes it
 * a partial match for every other member, so keep groups tight enough that
 * every pair inside one is defensible.
 *
 * This is a starting set, not an exhaustive one. It is expected to grow.
 */

/**
 * Each inner array is one equivalence class. The first entry is the canonical
 * name, used when reporting *what* a partial match matched via.
 *
 * @type {string[][]}
 */
export const SKILL_SYNONYM_GROUPS = [
  // --- Languages -----------------------------------------------------------
  ['JavaScript', 'JS', 'ECMAScript', 'ES6', 'ES2015', 'Vanilla JS'],
  ['TypeScript', 'TS'],
  ['Python', 'Python3', 'Python 3'],
  ['C#', 'CSharp', 'C Sharp', '.NET', 'dotnet', 'ASP.NET'],
  ['C++', 'CPP', 'Cplusplus'],
  ['Go', 'Golang'],
  ['Java', 'Java SE', 'Java EE', 'J2EE'],
  ['Ruby', 'Ruby on Rails', 'Rails', 'RoR'],
  ['PHP', 'Laravel', 'Symfony'],
  ['Rust', 'Rust-lang'],
  ['Kotlin', 'Kotlin Multiplatform'],
  ['Swift', 'SwiftUI'],
  ['Objective-C', 'ObjC'],
  ['Scala', 'Akka'],
  ['R', 'R Language', 'RStudio'],
  ['MATLAB', 'Matlab'],
  ['Shell', 'Bash', 'Zsh', 'Shell Scripting', 'Shell Script'],
  ['PowerShell', 'PWSH'],

  // --- Frontend ------------------------------------------------------------
  ['React', 'ReactJS', 'React.js'],
  ['Next.js', 'NextJS', 'Next'],
  ['Vue', 'VueJS', 'Vue.js', 'Vue 3'],
  ['Angular', 'AngularJS', 'Angular 2+'],
  ['Svelte', 'SvelteKit'],
  ['Redux', 'Redux Toolkit', 'RTK'],
  ['CSS', 'CSS3', 'Cascading Style Sheets'],
  ['Sass', 'SCSS', 'Less', 'Stylus'],
  ['Tailwind', 'Tailwind CSS', 'TailwindCSS'],
  ['HTML', 'HTML5', 'Semantic HTML'],
  ['Webpack', 'Vite', 'Rollup', 'Parcel', 'esbuild', 'Bundler'],
  ['React Native', 'ReactNative'],

  // --- Backend and APIs ----------------------------------------------------
  ['Node.js', 'NodeJS', 'Node'],
  ['Express', 'ExpressJS', 'Express.js'],
  ['Django', 'Django REST Framework', 'DRF'],
  ['Flask', 'FastAPI'],
  ['Spring', 'Spring Boot', 'SpringBoot'],
  ['REST', 'RESTful', 'REST API', 'RESTful API', 'HTTP API'],
  ['GraphQL', 'Apollo', 'Apollo GraphQL'],
  ['gRPC', 'Protocol Buffers', 'Protobuf'],
  ['WebSocket', 'WebSockets', 'Socket.IO'],
  ['Microservices', 'Microservice Architecture', 'Service-Oriented Architecture', 'SOA'],

  // --- Cloud ---------------------------------------------------------------
  ['AWS', 'Amazon Web Services', 'EC2', 'S3', 'Lambda', 'AWS Lambda'],
  ['Azure', 'Microsoft Azure', 'Azure DevOps'],
  ['GCP', 'Google Cloud', 'Google Cloud Platform'],
  ['Cloud', 'Cloud Computing', 'Cloud Infrastructure', 'Cloud Native'],
  ['Serverless', 'FaaS', 'Functions as a Service'],

  // --- Containers and orchestration ---------------------------------------
  ['Kubernetes', 'K8s', 'EKS', 'GKE', 'AKS'],
  ['Docker', 'Containers', 'Containerisation', 'Containerization', 'Podman'],
  ['Helm', 'Helm Charts'],

  // --- CI/CD and infrastructure -------------------------------------------
  ['CI/CD', 'CICD', 'CI', 'CD', 'Continuous Integration', 'Continuous Delivery', 'Continuous Deployment', 'Jenkins', 'GitHub Actions', 'GitLab CI', 'CircleCI', 'Travis CI', 'Bamboo', 'ArgoCD', 'Build Pipeline', 'Deployment Pipeline'],
  ['Terraform', 'OpenTofu', 'Infrastructure as Code', 'IaC', 'CloudFormation', 'Pulumi'],
  ['Ansible', 'Chef', 'Puppet', 'SaltStack', 'Configuration Management'],
  ['Linux', 'Unix', 'GNU/Linux', 'Ubuntu', 'Debian', 'CentOS', 'RHEL', 'Red Hat'],
  ['Nginx', 'Apache', 'HAProxy', 'Reverse Proxy', 'Load Balancer'],

  // --- Observability -------------------------------------------------------
  ['Observability', 'Monitoring', 'Telemetry', 'Prometheus', 'Grafana', 'Datadog', 'New Relic', 'Splunk', 'OpenTelemetry', 'Distributed Tracing', 'Jaeger'],
  ['Logging', 'Structured Logging', 'ELK', 'Elasticsearch Logstash Kibana'],
  ['SRE', 'Site Reliability Engineering', 'Site Reliability'],
  ['On-call', 'Oncall', 'On call', 'Incident Response', 'Incident Management'],

  // --- Databases -----------------------------------------------------------
  ['PostgreSQL', 'Postgres', 'PSQL', 'Postgresql'],
  ['MySQL', 'MariaDB'],
  ['SQL', 'Structured Query Language', 'T-SQL', 'PL/SQL', 'SQL Server', 'MSSQL'],
  ['MongoDB', 'Mongo', 'DocumentDB'],
  ['Redis', 'Memcached', 'In-memory Cache', 'Caching'],
  ['DynamoDB', 'Cassandra', 'ScyllaDB', 'NoSQL', 'Key-Value Store'],
  ['Elasticsearch', 'OpenSearch', 'Elastic', 'Lucene'],
  ['Snowflake', 'BigQuery', 'Redshift', 'Data Warehouse', 'Data Warehousing'],
  ['ORM', 'Prisma', 'SQLAlchemy', 'Hibernate', 'ActiveRecord', 'TypeORM'],

  // --- Streaming and messaging --------------------------------------------
  ['Kafka', 'Apache Kafka', 'Kinesis', 'Pulsar', 'Event Streaming', 'Event Stream'],
  ['RabbitMQ', 'SQS', 'ActiveMQ', 'Message Queue', 'Message Broker', 'Pub/Sub', 'PubSub'],
  ['Event-Driven', 'Event Driven Architecture', 'EDA', 'Event Sourcing'],

  // --- Data and ML ---------------------------------------------------------
  ['Machine Learning', 'ML', 'Statistical Learning'],
  ['Deep Learning', 'Neural Networks', 'DL'],
  ['AI', 'Artificial Intelligence'],
  ['LLM', 'Large Language Model', 'Generative AI', 'GenAI', 'Foundation Models'],
  ['NLP', 'Natural Language Processing'],
  ['PyTorch', 'Torch'],
  ['TensorFlow', 'Keras', 'TF'],
  ['Pandas', 'NumPy', 'SciPy', 'Polars'],
  ['Spark', 'Apache Spark', 'PySpark', 'Databricks', 'Hadoop', 'MapReduce'],
  ['Airflow', 'Apache Airflow', 'Dagster', 'Prefect', 'Luigi', 'Workflow Orchestration'],
  ['ETL', 'ELT', 'Data Pipeline', 'Data Pipelines', 'Data Engineering'],
  ['Data Analysis', 'Data Analytics', 'Analytics'],
  ['Data Visualisation', 'Data Visualization', 'Tableau', 'Looker', 'Power BI', 'PowerBI'],

  // --- Testing -------------------------------------------------------------
  ['Testing', 'Automated Testing', 'Test Automation', 'QA', 'Quality Assurance'],
  ['Unit Testing', 'Unit Tests', 'TDD', 'Test-Driven Development'],
  ['Integration Testing', 'E2E Testing', 'End-to-End Testing', 'Cypress', 'Playwright', 'Selenium'],
  ['Jest', 'Vitest', 'Mocha', 'Jasmine', 'PyTest', 'JUnit', 'RSpec'],

  // --- Version control and process ----------------------------------------
  ['Git', 'GitHub', 'GitLab', 'Bitbucket', 'Version Control', 'Source Control'],
  ['Agile', 'Scrum', 'Kanban', 'Sprint Planning', 'Agile Methodologies'],
  ['Code Review', 'Peer Review', 'Pull Request', 'PR Review'],
  ['Documentation', 'Technical Writing', 'Technical Documentation'],
  ['Mentoring', 'Mentorship', 'Coaching', 'Mentored'],
  ['Leadership', 'Tech Lead', 'Technical Leadership', 'Team Lead'],
  ['Stakeholder Management', 'Cross-functional Collaboration', 'Cross Functional'],

  // --- Security ------------------------------------------------------------
  ['Security', 'Application Security', 'AppSec', 'InfoSec', 'Cybersecurity'],
  ['Authentication', 'Authorisation', 'Authorization', 'OAuth', 'OAuth2', 'SSO', 'SAML', 'OIDC', 'JWT'],
  ['Encryption', 'Cryptography', 'TLS', 'SSL', 'PKI'],
  ['Compliance', 'SOC 2', 'SOC2', 'GDPR', 'HIPAA', 'PCI DSS', 'PCI-DSS'],

  // --- Mobile --------------------------------------------------------------
  ['iOS', 'iPhone', 'iOS Development'],
  ['Android', 'Android Development'],
  ['Flutter', 'Dart'],
  ['Mobile', 'Mobile Development', 'Mobile Engineering'],

  // --- Domain --------------------------------------------------------------
  ['Payments', 'Payment Processing', 'Payment Infrastructure', 'Billing'],
  ['Fintech', 'Financial Technology', 'Financial Services'],
  ['E-commerce', 'Ecommerce', 'Online Retail'],
  ['Performance', 'Performance Optimisation', 'Performance Optimization', 'Latency Optimisation', 'Latency Optimization'],
  ['Scalability', 'Scaling', 'High Availability', 'Distributed Systems'],
  ['API Design', 'System Design', 'Architecture', 'Software Architecture', 'Solution Architecture'],
  ['Refactoring', 'Technical Debt', 'Code Quality', 'Legacy Migration', 'Modernisation', 'Modernization'],
  ['Accessibility', 'A11y', 'WCAG', 'Section 508'],
  ['UX', 'User Experience', 'UI/UX', 'Usability'],
  ['Product Management', 'Product Strategy', 'Roadmap', 'Product Roadmap'],
];

/**
 * Normalise a term for lookup. Case, surrounding punctuation, and the
 * separators people vary freely (spaces, hyphens, underscores, dots) are all
 * flattened, so "Node.js", "node js", "NodeJS" and "node-js" collide.
 *
 * Deliberately *not* flattened: `+` and `#`. Those carry identity -- C, C++
 * and C# are three different skills, and folding them together would be the
 * exact bug the boundary logic in gapAnalyzer.js exists to prevent.
 *
 * @param {unknown} term
 * @returns {string} Empty string for anything that is not usable text.
 */
export function normaliseSkill(term) {
  if (typeof term !== 'string') return '';

  return term
    .toLowerCase()
    .trim()
    .replace(/[\s._\-/\\]+/g, '') // separators people vary freely
    .replace(/[^a-z0-9+#]/g, ''); // keep + and #: they are part of the name
}

/**
 * term (normalised) -> index of its group in SKILL_SYNONYM_GROUPS.
 * @type {Map<string, number>}
 */
const GROUP_INDEX = new Map();

SKILL_SYNONYM_GROUPS.forEach((group, groupId) => {
  for (const term of group) {
    const key = normaliseSkill(term);
    if (!key) continue;

    // First group to claim a term wins. A term appearing in two groups is a
    // modelling mistake -- it would silently merge two equivalence classes
    // through transitivity -- so it is reported rather than accommodated.
    if (GROUP_INDEX.has(key) && GROUP_INDEX.get(key) !== groupId) {
      const other = SKILL_SYNONYM_GROUPS[GROUP_INDEX.get(key)][0];
      console.warn(`skillSynonyms: "${term}" is in both "${other}" and "${group[0]}"; keeping "${other}".`);
      continue;
    }
    GROUP_INDEX.set(key, groupId);
  }
});

/**
 * The canonical name for a term's group -- what a partial match matched via.
 *
 * @param {unknown} term
 * @returns {string|null} Canonical name, or null if the term is unknown.
 */
export function canonicalise(term) {
  const groupId = GROUP_INDEX.get(normaliseSkill(term));
  return groupId === undefined ? null : SKILL_SYNONYM_GROUPS[groupId][0];
}

/**
 * Every term equivalent to this one, excluding the term itself.
 *
 * @param {unknown} term
 * @returns {string[]} Empty if the term is unknown.
 */
export function getSynonyms(term) {
  const key = normaliseSkill(term);
  const groupId = GROUP_INDEX.get(key);
  if (groupId === undefined) return [];

  return SKILL_SYNONYM_GROUPS[groupId].filter((t) => normaliseSkill(t) !== key);
}

/**
 * Do two terms name the same thing, or close enough for partial credit?
 * Identical terms count -- callers that need to exclude the exact-match case
 * should compare normalised forms themselves.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function areSynonyms(a, b) {
  const keyA = normaliseSkill(a);
  const keyB = normaliseSkill(b);
  if (!keyA || !keyB) return false;
  if (keyA === keyB) return true;

  const groupA = GROUP_INDEX.get(keyA);
  return groupA !== undefined && groupA === GROUP_INDEX.get(keyB);
}

/** @returns {boolean} Whether the term appears anywhere in the map at all. */
export function isKnownSkill(term) {
  return GROUP_INDEX.has(normaliseSkill(term));
}

/** Total distinct terms indexed. Handy for a sanity check in tests. */
export const INDEXED_TERM_COUNT = GROUP_INDEX.size;
