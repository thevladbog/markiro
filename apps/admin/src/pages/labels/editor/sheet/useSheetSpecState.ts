import { useReducer, useState } from "react";
import type { PalletSheetSpecV2, SheetNode } from "@markiro/domain";
export interface SheetHistory {
  past: PalletSheetSpecV2[];
  present: PalletSheetSpecV2;
  future: PalletSheetSpecV2[];
}
export type SheetHistoryAction =
  { type: "change"; spec: PalletSheetSpecV2 } | { type: "undo" | "redo" };
export function createSheetHistory(spec: PalletSheetSpecV2): SheetHistory {
  return { past: [], present: spec, future: [] };
}
export function sheetHistoryReducer(state: SheetHistory, action: SheetHistoryAction): SheetHistory {
  if (action.type === "change") {
    if (JSON.stringify(action.spec) === JSON.stringify(state.present)) return state;
    return { past: [...state.past.slice(-49), state.present], present: action.spec, future: [] };
  }
  if (action.type === "undo") {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return {
      past: state.past.slice(0, -1),
      present: previous,
      future: [state.present, ...state.future],
    };
  }
  const next = state.future[0];
  if (!next) return state;
  return { past: [...state.past, state.present], present: next, future: state.future.slice(1) };
}
export function findSheetNode(spec: PalletSheetSpecV2, id: string): SheetNode | undefined {
  const find = (nodes: SheetNode[]): SheetNode | undefined => {
    for (const node of nodes) {
      if (node.id === id) return node;
      if ("children" in node) {
        const child = find(node.children);
        if (child) return child;
      }
    }
    return undefined;
  };
  return find(spec.body);
}
export function sheetNodeParent(spec: PalletSheetSpecV2, id: string): string | null {
  const visit = (nodes: SheetNode[], parent: string | null): string | null | undefined => {
    for (const node of nodes) {
      if (node.id === id) return parent;
      if ("children" in node) {
        const result = visit(node.children, node.id);
        if (result !== undefined) return result;
      }
    }
    return undefined;
  };
  return visit(spec.body, null) ?? null;
}
export function replaceSheetNode(
  spec: PalletSheetSpecV2,
  id: string,
  update: (node: SheetNode) => SheetNode,
): PalletSheetSpecV2 {
  let found = false;
  const visit = (nodes: SheetNode[]): SheetNode[] =>
    nodes.map((node) => {
      if (node.id === id) {
        found = true;
        return update(node);
      }
      return "children" in node ? { ...node, children: visit(node.children) } : node;
    });
  const body = visit(spec.body);
  if (!found)
    throw new Error(
      id === spec.footer.id
        ? "Mandatory SSCC footer cannot be removed or moved"
        : "Element no longer exists",
    );
  return { ...spec, body };
}
export function insertSheetNode(
  spec: PalletSheetSpecV2,
  parentId: string | null,
  node: SheetNode,
  index?: number,
): PalletSheetSpecV2 {
  if (findSheetNode(spec, node.id) || node.id === spec.footer.id)
    throw new Error("Element id already exists");
  const insert = (nodes: SheetNode[]) => {
    const result = [...nodes];
    result.splice(index ?? result.length, 0, node);
    return result;
  };
  if (parentId === null) return { ...spec, body: insert(spec.body) };
  return replaceSheetNode(spec, parentId, (parent) => {
    if (!("children" in parent)) throw new Error("Choose a container");
    return { ...parent, children: insert(parent.children) };
  });
}
export function removeSheetNode(spec: PalletSheetSpecV2, id: string): PalletSheetSpecV2 {
  if (id === spec.footer.id) throw new Error("Mandatory SSCC footer cannot be removed or moved");
  if (!findSheetNode(spec, id)) throw new Error("Element no longer exists");
  const remove = (nodes: SheetNode[]): SheetNode[] =>
    nodes
      .filter((node) => node.id !== id)
      .map((node) => ("children" in node ? { ...node, children: remove(node.children) } : node));
  return { ...spec, body: remove(spec.body) };
}
export function moveSheetNode(
  spec: PalletSheetSpecV2,
  id: string,
  parentId: string | null,
  index: number,
): PalletSheetSpecV2 {
  const node = findSheetNode(spec, id);
  if (!node)
    throw new Error(
      id === spec.footer.id ? "Mandatory SSCC footer cannot be moved" : "Element no longer exists",
    );
  const contains = (candidate: SheetNode): boolean =>
    candidate.id === parentId || ("children" in candidate && candidate.children.some(contains));
  if (contains(node)) throw new Error("A move would create a cycle");
  return insertSheetNode(removeSheetNode(spec, id), parentId, node, index);
}
export function useSheetSpecState(initial: PalletSheetSpecV2) {
  const [history, dispatch] = useReducer(sheetHistoryReducer, initial, createSheetHistory);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return {
    spec: history.present,
    selectedId,
    select: setSelectedId,
    change: (spec: PalletSheetSpecV2) => dispatch({ type: "change", spec }),
    undo: () => dispatch({ type: "undo" }),
    redo: () => dispatch({ type: "redo" }),
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
  };
}
