// Function-side tool registry barrel.
//
// Importing this file as a side-effect (./tools/index.ts) triggers
// every individual tool module's `registerTool()` call. The
// performToolCall dispatcher then has the full registry populated
// before the first /stream request lands.
//
// Order within this barrel is irrelevant - each tool's registration
// is independent and the dispatcher's REGISTRY map is order-agnostic.
// Tools are listed alphabetically for the next reader's benefit.
//
// When a new tool ports, add one `import './name.ts'` line here. The
// barrel itself stays mechanical; no export surface, no logic.

import './ask_user.ts';
import './conversation_get.ts';
import './doc_get.ts';
import './doc_list.ts';
import './memory_create.ts';
import './memory_delete.ts';
import './memory_doubt.ts';
import './memory_reaffirm.ts';
import './memory_relate.ts';
import './memory_unrelate.ts';
import './memory_update.ts';
import './recipe_get.ts';
import './recipe_list.ts';
import './toggle_tools.ts';
import './update_title.ts';
import './wiki_get.ts';
import './wiki_list.ts';
