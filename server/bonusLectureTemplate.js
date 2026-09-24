// Builds the standard Starweaver "Bonus Lecture" article body, replicating the
// exact template already live on 98 courses (minus the STAR_STUDENTS discount
// block, which was removed from all of them on 2026-07-30).
//
// Everything here is derived from the real published bodies — the recommendation
// pool below carries the REAL referral codes scraped from those live articles
// (each destination course has exactly one stable code; verified across all 98).

// --- Recommendation pool: slug -> { code, label, desc } -------------------
// `code` null = the live articles link this course without a referral code.
export const POOL = {
  'mastering-prompt-engineering-for-generative-ai-z': { code: '2EB376B3A208409D5758', label: 'Mastering Prompt Engineering for Generative AI', desc: 'The essential skill for anyone working with AI models and ChatGPT.' },
  'designing-autonomous-ai-agents': { code: '67E54BCF2351566B7A20', label: 'Build RAG Systems: Generative AI &amp; LangChain Mastery', desc: 'Learn to develop production-ready GenAI applications using RAG architecture.' },
  'genai-ceo-playbook-amplifying-visionary-leadership': { code: '1EA87CDBB6ED39DB7A4C', label: 'GenAI for CEOs: Strategy, Innovation &amp; Competitive Advantage', desc: 'Strategic AI leadership for executives and decision-makers.' },
  'end-to-end-genai-model-engineering': { code: '5A9E95DAE1BCABE0575F', label: 'End-to-End GenAI Model Engineering', desc: 'Cover the complete lifecycle from data to deployment for GenAI systems.' },
  'ai-at-scale-roadmap-for-enterprise-transformation': { code: 'C964E638F8070AA01CF6', label: 'AI at Scale: Roadmap for Enterprise Transformation', desc: 'Successfully scale AI across your organization.' },
  'ai-for-strategic-hr-operations-and-compliance-z': { code: '1D92F266C764162066ED', label: 'AI for Strategic HR Operations and Compliance', desc: 'Enhance HR with AI-driven recruitment, retention, and compliance solutions.' },

  'cyber-threat-intelligence-basics-fundamentals-x': { code: 'A24A8ED63CE3889340D8', label: 'Mastering Basics of Cyber Threat Intelligence', desc: 'Build critical threat intelligence skills for modern SOC operations.' },
  'critical-concepts-in-incident-response-frameworks': { code: '67204BA3D67A7A166A59', label: 'Critical Concepts in Incident Response Frameworks', desc: 'Master incident response to protect organizations during security events.' },
  'mastering-nist-and-iso-cybersecurity-governance-in-16-steps': { code: '51366B0CCB28E95643E6', label: 'Mastering NIST and ISO Cybersecurity Governance in 16 Steps', desc: 'Align security programs with recognised governance frameworks.' },
  'a-practical-guide-to-threat-hunting-techniques': { code: '455C5BD2DF31B21B319E', label: 'A Practical Guide to Threat Hunting Techniques', desc: 'Proactively hunt threats before they become incidents.' },
  'mastering-digital-forensics-essentialsc': { code: 'C446333D5F57655E3173', label: 'Mastering Digital Forensics Essentials', desc: 'Investigate incidents and preserve evidence with confidence.' },
  'mastering-leadership-in-cybersecurity-oversight': { code: '04DE7811A65AB29AE42B', label: 'Mastering Leadership in Cybersecurity Oversight', desc: 'Lead security programs and align with business objectives.' },

  'credit-analysis-academy': { code: 'B1DC2332AA0E555FBAAB', label: 'Master Credit Analysis', desc: 'Build end-to-end credit analysis and underwriting skills.' },
  'credit-portfolio-strategy-and-regulatory-compliance': { code: 'E7F559A179A1E3906AA0', label: 'Credit Portfolio Strategy and Regulatory Compliance', desc: 'Manage credit portfolios within evolving regulatory demands.' },
  'strategic-credit-modeling-and-advanced-financial-diagnostics': { code: '34E164B4C886D39C2251', label: 'Strategic Credit Modeling and Advanced Financial Diagnostics', desc: 'Model credit risk and diagnose financial health with rigour.' },
  'practical-ai-for-finance-automate-forecast-and-optimize': { code: 'EFA5270BD431547FD860', label: 'AI for Finance: Predictive Analytics &amp; Risk Intelligence', desc: 'Apply AI to forecasting, risk and financial decision-making.' },
  'blockchain-essentials-for-finance-professionals': { code: '19F97CCB267A0DD847C5', label: 'Blockchain Essentials for Finance Professionals', desc: "Understand blockchain technology's impact on financial services." },
  'personal-investing-for-working-professionals': { code: 'B0875A00CC805DDD169D', label: 'Personal Investing for Working Professionals', desc: 'Build a practical, long-term personal investing approach.' },

  'the-executive-communicator-leading-with-clarity': { code: '6407926B80F85165B8C7', label: 'The Executive Communicator: Leading with Clarity', desc: 'Communicate with authority and influence at senior levels.' },
  'leadership-in-change-management-and-innovation': { code: '7F0BEA0CF71106380238', label: 'Leadership in Change Management and Innovation', desc: 'Lead teams confidently through change and innovation.' },
  'the-executive-leaders-complete-guide-to-success': { code: 'F9C4A119D0BBCA558618', label: "The Executive Leader's Complete Guide to Success", desc: 'A complete toolkit for stepping up to executive leadership.' },
  'mastering-strategic-sales-leadership': { code: '8D24643A716AF560985E', label: 'Mastering Strategic Sales Leadership', desc: 'Lead high-performing sales teams with a strategic playbook.' },
  'precision-writing-mastering-business-technical-style': { code: '048B5B02F752EDF7F4C0', label: 'Precision Writing: Mastering Business &amp; Technical Style', desc: 'Write clearly and persuasively for business and technical audiences.' },
  'storytelling-with-data-boosting-b2b-b2c-sales': { code: 'A16E0C063E0EF2C742B4', label: 'Storytelling with Data: Boosting B2B &amp; B2C Sales', desc: 'Turn data into compelling narratives that drive decisions.' },

  'expert-strategies-for-ai-driven-ehr-data-management': { code: '757270DD264F170D77FC', label: 'Expert Strategies for AI-Driven EHR &amp; Data Management', desc: 'Transform clinical workflows with AI-powered EHR optimization.' },
  'ai-innovations-with-open-tools-in-healthcare-processes': { code: 'BAF612D45BF75F98ACC8', label: 'Transforming Healthcare Processes with AI and Open Tools', desc: 'Redesign healthcare operations with AI and automation.' },
  'advanced-digital-health-data-governance-essentials': { code: 'D066969A685325A90C88', label: 'Advanced Digital Health Data &amp; Governance Essentials', desc: 'Master healthcare data governance, privacy and compliance.' },
  'expert-strategies-for-ai-in-clinical-decision-support': { code: 'F43082F69AB8FDC08897', label: 'Expert Strategies for AI in Clinical Decision Support', desc: 'Apply AI to clinical decision-making and patient outcomes.' },
  'innovative-ai-practices-in-telemedicine-virtual-care': { code: '2C2449C95D1AB163E48D', label: 'Innovative AI Practices in Telemedicine &amp; Virtual Care', desc: 'Deliver better virtual care with AI-enabled workflows.' },
  'healthcare-data-security-and-risk-management-guide': { code: '9262A41FCD2AE3067838', label: 'Healthcare Data Security and Risk Management Guide', desc: 'Protect patient data and manage healthcare security risk.' },

  'genai-data-and-analytics-academy': { code: 'ECACE6094C5D519B03A2', label: 'GenAI for Data Analytics', desc: 'Bring generative AI into everyday analytics work.' },
  'ai-for-product-and-process-optimization': { code: '2E70E64F544B5FB6D3E3', label: 'AI for Product and Process Optimization', desc: 'Optimize products and processes with practical AI.' },
  'intelligent-business-operations': { code: '767429282705E21BA4E1', label: 'Intelligent Business Operations', desc: 'Run smarter, data-driven business operations.' },
};

// --- Topic clusters (the 6 recommendations per subject area) --------------
// AI / CYBER / FINANCE / LEADERSHIP / HEALTH mirror the sets already live.
// BUSINESS is assembled from the same pool for marketing/ecommerce courses,
// which had no existing cluster (per your "use related domain titles" call).
export const CLUSTERS = {
  AI: ['mastering-prompt-engineering-for-generative-ai-z','designing-autonomous-ai-agents','genai-ceo-playbook-amplifying-visionary-leadership','end-to-end-genai-model-engineering','ai-at-scale-roadmap-for-enterprise-transformation','ai-for-strategic-hr-operations-and-compliance-z'],
  CYBER: ['cyber-threat-intelligence-basics-fundamentals-x','critical-concepts-in-incident-response-frameworks','mastering-nist-and-iso-cybersecurity-governance-in-16-steps','a-practical-guide-to-threat-hunting-techniques','mastering-digital-forensics-essentialsc','mastering-leadership-in-cybersecurity-oversight'],
  FINANCE: ['credit-analysis-academy','credit-portfolio-strategy-and-regulatory-compliance','strategic-credit-modeling-and-advanced-financial-diagnostics','practical-ai-for-finance-automate-forecast-and-optimize','blockchain-essentials-for-finance-professionals','personal-investing-for-working-professionals'],
  LEADERSHIP: ['the-executive-communicator-leading-with-clarity','leadership-in-change-management-and-innovation','the-executive-leaders-complete-guide-to-success','mastering-strategic-sales-leadership','precision-writing-mastering-business-technical-style','storytelling-with-data-boosting-b2b-b2c-sales'],
  HEALTH: ['expert-strategies-for-ai-driven-ehr-data-management','ai-innovations-with-open-tools-in-healthcare-processes','advanced-digital-health-data-governance-essentials','expert-strategies-for-ai-in-clinical-decision-support','innovative-ai-practices-in-telemedicine-virtual-care','healthcare-data-security-and-risk-management-guide'],
  BUSINESS: ['storytelling-with-data-boosting-b2b-b2c-sales','mastering-strategic-sales-leadership','intelligent-business-operations','genai-data-and-analytics-academy','ai-for-product-and-process-optimization','mastering-prompt-engineering-for-generative-ai-z'],
};

// The student-discount coupon promoted in every bonus lecture. This is a REAL
// Udemy coupon and it expires. BESTPRICE lapsed on 2026-09-05 and sat dead in
// ~140 live lectures for two days before anyone noticed — when this one nears
// its date, update the constant and re-run applyBonusDiscountBlock.js.
// SEPT_BESTPRICE runs to 2026-10-08 (verified live on 2026-09-07).
export const DISCOUNT_CODE = 'SEPT_BESTPRICE';

const JB_SIGNUP = 'https://app.journeybuilder.ai/signup?utm_source=Udemy+Bonus+Section&amp;utm_medium=Udemy_Bonus_section_JBsignup_17%2F02%2F2026&amp;utm_campaign=Udemy_Bonus_section_17%2F02%2F2026_JBsignup_campaign';
const JB_HOME = 'https://www.journeybuilder.ai/?utm_source=Udemy+Bonus+Section&amp;utm_medium=Udemy_Bonus_section_JB_17%2F02%2F2026&amp;utm_campaign=Udemy_Bonus_section_17%2F02%2F2026_JB_campaign';

const A = (href, inner) => `<a href="${href}" rel="noopener noreferrer" target="_blank">${inner}</a>`;

// Course titles are interpolated into HTML, so `&` and angle brackets must be
// escaped. Skipping this produced invalid HTML that Udemy silently normalised
// on save (e.g. "Data & Analytics" -> "Data &amp; Analytics"), so the stored
// body no longer matched what we sent. POOL labels are already escaped.
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Copy in both languages. Spanish mirrors the English block-for-block.
const COPY = {
  en: {
    h1: 'Thank You &amp; Next Steps',
    thanks: (n) => `Thank you for completing ${n} with Starweaver!`,
    cta: 'To help reinforce your learning, choose one small project or real-world use case from your work and apply at least 2–3 concepts from this course over the next week. Once you’ve done that, return to leave a course review and share what changed for you. Your feedback supports other learners and helps us improve.',
    recH: 'Recommended Next Courses for You',
    recLead: 'Continue building your expertise with these impactful programs:',
    discountH: 'Exclusive Student Discount',
    discountBody: (code) => `Use code <strong>${code}</strong> to access the best price on all our Udemy courses.`,
    pathH: 'Personalised Learning Path',
    pathBody: (link) => `Looking for a more structured way to learn? Try ${link}, Starweaver’s interactive platform designed to create a customised learning path based on your goals, role, and skill level.`,
    bullets: ['Find the right courses quickly','Follow a clear, step-by-step progression','Monitor your progress and develop job-ready skills'],
    pathStart: (link) => `Start your personalised journey here: ${link}`,
    connH: 'Stay Connected',
    connLead: 'Visit our Udemy profile for the full Starweaver catalogue:',
    closing: 'Thank you for being a valued member of the Starweaver learning community!',
  },
  es: {
    h1: 'Gracias y próximos pasos',
    thanks: (n) => `¡Gracias por completar ${n} con Starweaver!`,
    cta: 'Para reforzar tu aprendizaje, elige un pequeño proyecto o caso de uso real de tu trabajo y aplica al menos 2–3 conceptos de este curso durante la próxima semana. Cuando lo hayas hecho, vuelve para dejar una reseña del curso y compartir qué cambió para ti. Tus comentarios ayudan a otros estudiantes y nos permiten mejorar.',
    recH: 'Próximos cursos recomendados para ti',
    recLead: 'Sigue desarrollando tu experiencia con estos programas de gran impacto (disponibles en inglés):',
    discountH: 'Descuento exclusivo para estudiantes',
    discountBody: (code) => `Usa el código <strong>${code}</strong> para acceder al mejor precio en todos nuestros cursos de Udemy.`,
    pathH: 'Ruta de aprendizaje personalizada',
    pathBody: (link) => `¿Buscas una forma más estructurada de aprender? Prueba ${link}, la plataforma interactiva de Starweaver diseñada para crear una ruta de aprendizaje personalizada según tus objetivos, tu rol y tu nivel de conocimientos.`,
    bullets: ['Encuentra rápidamente los cursos adecuados','Sigue una progresión clara, paso a paso','Supervisa tu progreso y desarrolla habilidades listas para el trabajo'],
    pathStart: (link) => `Comienza tu recorrido personalizado aquí: ${link}`,
    connH: 'Mantente conectado',
    connLead: 'Visita nuestro perfil de Udemy para ver el catálogo completo de Starweaver:',
    closing: '¡Gracias por ser un miembro valioso de la comunidad de aprendizaje de Starweaver!',
  },
};

/**
 * The label shown for a recommended course.
 *
 * POOL.label is a title captured when these articles were first authored, and
 * Udemy titles change — by 2026-08 only 4 of the 33 still matched. So prefer
 * the live title whenever the caller supplies a catalogue, and fall back to the
 * stored label only for a slug the catalogue does not know. Live titles are raw
 * text and must be escaped; POOL labels are already escaped.
 */
export function labelFor(slug, titlesBySlug) {
  const live = titlesBySlug?.[slug];
  return live ? esc(live) : POOL[slug].label;
}

/**
 * Build the bonus-lecture article HTML.
 * @param {string} courseName exact course title (used verbatim in the thank-you line)
 * @param {string} cluster    key of CLUSTERS
 * @param {'en'|'es'} lang
 * @param {{titlesBySlug?: Record<string,string>}} [opts] live Udemy titles keyed
 *        by published_title slug; without it the stored POOL labels are used.
 */
export function buildBonusBody(courseName, cluster, lang = 'en', opts = {}) {
  const c = COPY[lang];
  const slugs = CLUSTERS[cluster];
  if (!slugs) throw new Error(`unknown cluster: ${cluster}`);

  const recs = slugs.map((s) => {
    const p = POOL[s];
    if (!p) throw new Error(`slug not in POOL: ${s}`);
    const href = p.code
      ? `https://www.udemy.com/course/${s}/?referralCode=${p.code}`
      : `https://www.udemy.com/course/${s}`;
    return `<p>• ${A(href, labelFor(s, opts.titlesBySlug))} – ${p.desc}</p>`;
  }).join('');

  // BR used to emit a literal blank paragraph (`<p><br></p>`) before each major
  // heading. On top of Udemy's own paragraph margins that rendered as a gap
  // roughly two lines deep, which read as a mistake, so the spacers were
  // dropped on 2026-08-10 and the normal margin now does the separating.
  // Kept as a named empty string so the section layout below stays readable.
  const BR = '';

  return [
    `<p><strong>${c.h1}</strong></p>`,
    `<p>${c.thanks(esc(courseName))}</p>`,
    `<p>${c.cta}</p>`,
    BR,
    `<p><strong>${c.recH}</strong></p>`,
    `<p><strong>${c.recLead}</strong></p>`,
    recs,
    BR,
    `<p><strong>${c.discountH}</strong></p>`,
    `<p>${c.discountBody(DISCOUNT_CODE)}</p>`,
    BR,
    `<p><strong>${c.pathH}</strong></p>`,
    `<p>${c.pathBody(A(JB_SIGNUP, '<strong>Journeybuilder</strong>'))}</p>`,
    ...c.bullets.map((b) => `<p>• ${b}</p>`),
    `<p>${c.pathStart(A(JB_HOME, '<strong>Journeybuilder</strong>'))}</p>`,
    BR,
    `<p><strong>${c.connH}</strong></p>`,
    `<p>${c.connLead}</p>`,
    `<p>${A('https://www.udemy.com/user/paulsiegel2/', 'https://www.udemy.com/user/paulsiegel2/')}</p>`,
    `<p>Website - ${A('https://www.starweaver.com/', 'https://www.starweaver.com')} <br>Facebook - ${A('https://www.facebook.com/starweavergroup/', 'https://www.facebook.com/starweavergroup/')}</p>`,
    `<p>Instagram- ${A('https://www.instagram.com/starweavergroup/', 'https://www.instagram.com/starweavergroup/')}</p>`,
    `<p>LinkedIn- ${A('https://www.linkedin.com/company/starweaver', 'https://www.linkedin.com/company/starweaver')}</p>`,
    `<p>X- ${A('https://x.com/starweavergroup', 'https://x.com/starweavergroup')}</p>`,
    BR,
    `<p>${c.closing}</p>`,
  ].join('');
}
