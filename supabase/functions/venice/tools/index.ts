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
// When a new tool ports, add one side-effect import line below
// (./your_tool_name.ts). The barrel itself stays mechanical; no
// export surface, no logic. Phrased without the literal import
// keyword inside the comment because supabase functions serve's
// hot-reload scans source naively and would try to resolve a
// fictitious module path from the example.

import './analyze_image.ts';
import './ask_user.ts';
import './conversation_get.ts';
import './conversation_search.ts';
import './doc_create.ts';
import './doc_delete.ts';
import './doc_get.ts';
import './doc_grep.ts';
import './doc_list.ts';
import './doc_read.ts';
import './doc_update.ts';
import './generate_image.ts';
import '../agents/context.ts';
import '../agents/conversation_recall.ts';
import '../agents/recall.ts';
import '../agents/wiki_librarian.ts';
import '../agents/wiki_recall.ts';
import './memory_consolidate.ts';
import './memory_create.ts';
import './memory_delete.ts';
import './memory_doubt.ts';
import './memory_invalidate.ts';
import './memory_reaffirm.ts';
import './memory_relate.ts';
import './memory_search.ts';
import './memory_unrelate.ts';
import './memory_update.ts';
import './recipe_delete.ts';
import './recipe_get.ts';
import './recipe_list.ts';
import './recipe_photos.ts';
import './recipe_save.ts';
import './recipe_update.ts';
import './research_docs.ts';
import './toggle_tools.ts';
import './update_title.ts';
import './web_search.ts';
import './wiki_create.ts';
import './wiki_delete.ts';
import './wiki_get.ts';
import './wiki_list.ts';
import './wiki_search.ts';
import './wiki_update.ts';
import './record_create.ts';
import './record_delete.ts';
import './record_get.ts';
import './record_list.ts';
import './record_search.ts';
import './record_update.ts';
import './record_file_attach.ts';
import './record_file_remove.ts';
import './record_link_create.ts';
import './record_link_delete.ts';
