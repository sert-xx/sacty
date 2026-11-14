// 図の一覧。足すときは、ここに並べる。
import { auditFlow, deploymentState, memoryFlow, memoryPromotion } from "./after-merge.mjs";
import architecture from "./architecture.mjs";
import { budgetFlow, questionFlow } from "./budget-question.mjs";
import { contextLayers, contextMcp, contextMerge } from "./context.mjs";
import gateway from "./gateway.mjs";
import gatewayPf from "./gateway-pf.mjs";
import { introFlow, introLoop } from "./intro.mjs";
import { approvalBranches, tasksFlow } from "./tasks.mjs";
import {
  auditUser,
  composeUser,
  contextExtends,
  contextLocked,
  contextMcpUser,
  deploymentUser,
  gatewayUser,
  overview,
  tasksUser,
} from "./user.mjs";

export const DIAGRAMS = [
  // 仕様書
  architecture,
  gateway,
  gatewayPf,
  contextLayers,
  contextMerge,
  contextMcp,
  tasksFlow,
  approvalBranches,
  budgetFlow,
  questionFlow,
  deploymentState,
  memoryFlow,
  memoryPromotion,
  auditFlow,
  // ユーザードキュメント
  introFlow,
  introLoop,
  overview,
  gatewayUser,
  contextExtends,
  contextLocked,
  contextMcpUser,
  tasksUser,
  deploymentUser,
  auditUser,
  composeUser,
];
