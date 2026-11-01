// Small DOM helpers shared by the page editor and form filling.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "dataset") Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

// actions: [{label, primary, onClick(close) -> true to keep the dialog open}]
export function openModal({ title, body, actions = [], onClose }) {
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    if (onClose) onClose();
  };
  const onKey = (e) => {
    if (e.key === "Escape") close();
  };
  const foot = h("div", { class: "modal-foot" });
  for (const a of actions) {
    foot.append(
      h(
        "button",
        {
          class: "btn" + (a.primary ? " btn-primary" : ""),
          onclick: async () => {
            const keepOpen = a.onClick ? await a.onClick(close) : false;
            if (!keepOpen) close();
          },
        },
        a.label
      )
    );
  }
  const backdrop = h(
    "div",
    { class: "modal-backdrop", onmousedown: (e) => e.target === backdrop && close() },
    h(
      "div",
      { class: "modal" },
      h("div", { class: "modal-head" }, h("span", {}, title), h("button", { class: "btn-icon", onclick: close }, "✕")),
      h("div", { class: "modal-body" }, body),
      actions.length ? foot : null
    )
  );
  document.body.append(backdrop);
  document.addEventListener("keydown", onKey);
  return { close, backdrop };
}
