use crate::resolver::Resolver;
use sha1::{Digest, Sha1};
use std::{cell::RefCell, path::Path, rc::Rc};
use swc_common::{SourceMap, Span, DUMMY_SP};
use swc_ecma_ast::*;
use swc_ecma_utils::quote_ident;
use swc_ecma_visit::{noop_fold_type, Fold, FoldWith};

pub fn resolve_fold(
  resolver: Rc<RefCell<Resolver>>,
  source: Rc<SourceMap>,
  is_dev: bool,
) -> impl Fold {
  ResolveFold {
    use_deno_idx: 0,
    resolver,
    source,
    is_dev,
  }
}

pub struct ResolveFold {
  resolver: Rc<RefCell<Resolver>>,
  source: Rc<SourceMap>,
  is_dev: bool,
  use_deno_idx: i32,
}

impl ResolveFold {
  fn new_use_deno_hook_ident(&mut self, callback_span: &Span) -> String {
    let resolver = self.resolver.borrow_mut();
    self.use_deno_idx = self.use_deno_idx + 1;
    let mut ident: String = "useDeno-".to_owned();
    let mut hasher = Sha1::new();
    let callback_code = self.source.span_to_snippet(callback_span.clone()).unwrap();
    hasher.update(resolver.specifier.clone());
    hasher.update(self.use_deno_idx.to_string());
    hasher.update(callback_code.clone());
    ident.push_str(
      base64::encode(hasher.finalize())
        .replace("+", "")
        .replace("/", "")
        .replace("=", "")
        .as_str(),
    );
    ident
  }
}

impl Fold for ResolveFold {
  noop_fold_type!();

  // resolve import/export url
  // [/pages/index.tsx]
  // - dev mode:
  //   - `import React, { useState } from "https://esm.sh/react"` -> `import React, {useState} from "/-/esm.sh/react.js"`
  //   - `import * as React from "https://esm.sh/react"` -> `import * as React from "/-/esm.sh/react.js"`
  //   - `import Logo from "../components/logo.tsx"` -> `import Logo from "/components/logo.js"`
  //   - `import "../style/index.css" -> `import "/style/index.css.js"`
  //   - `export React, {useState} from "https://esm.sh/react"` -> `export React, {useState} from * from "/-/esm.sh/react.js"`
  //   - `export * from "https://esm.sh/react"` -> `export * from "/-/esm.sh/react.js"`
  // - bundle mode:
  //   - `import React, { useState } from "https://esm.sh/react"` -> `const { default: React, useState } = __ALEPH.pack["https://esm.sh/react"];`
  //   - `import * as React from "https://esm.sh/react"` -> `const React = __ALEPH.pack["https://esm.sh/react"]`
  //   - `import Logo from "../components/logo.tsx"` -> `const { default: Logo } = __ALEPH.pack["/components/logo.tsx"]`
  //   - `export React, {useState} from "https://esm.sh/react"` -> `export const { default: React, useState } = __ALEPH.pack["https://esm.sh/react"]`
  //   - `export * from "https://esm.sh/react"` -> `export const $$star_N = __ALEPH.pack["https://esm.sh/react"]`
  fn fold_module_items(&mut self, module_items: Vec<ModuleItem>) -> Vec<ModuleItem> {
    let mut items = Vec::<ModuleItem>::new();
    let aleph_pkg_uri = self.resolver.borrow().get_aleph_pkg_uri();
    let used_builtin_jsx_tags = self.resolver.borrow().used_builtin_jsx_tags.clone();
    let extra_imports = self.resolver.borrow().extra_imports.clone();

    for name in used_builtin_jsx_tags.clone() {
      let mut resolver = self.resolver.borrow_mut();
      let id_name = if name.eq("a") {
        "__ALEPH_anchor".to_owned()
      } else {
        "__ALEPH_".to_owned() + name.as_str()
      };
      let id = quote_ident!(id_name);
      let (resolved_path, fixed_url) = resolver.resolve(
        format!("{}/framework/react/components/{}.ts", aleph_pkg_uri, name).as_str(),
        false,
      );
      if resolver.bundle_mode && resolver.bundle_externals.contains(fixed_url.as_str()) {
        items.push(ModuleItem::Stmt(Stmt::Decl(Decl::Var(VarDecl {
          span: DUMMY_SP,
          kind: VarDeclKind::Const,
          declare: false,
          decls: vec![create_aleph_pack_var_decl_member(
            fixed_url.as_str(),
            vec![(id, Some("default".into()))],
          )],
        }))));
      } else {
        items.push(ModuleItem::ModuleDecl(ModuleDecl::Import(ImportDecl {
          span: DUMMY_SP,
          specifiers: vec![ImportSpecifier::Default(ImportDefaultSpecifier {
            span: DUMMY_SP,
            local: id,
          })],
          src: Str {
            span: DUMMY_SP,
            value: resolved_path.into(),
            has_escape: false,
            kind: Default::default(),
          },
          type_only: false,
          asserts: None,
        })));
      }
    }

    for imp in extra_imports {
      items.push(ModuleItem::ModuleDecl(ModuleDecl::Import(ImportDecl {
        span: DUMMY_SP,
        specifiers: vec![],
        src: Str {
          span: DUMMY_SP,
          value: imp.into(),
          has_escape: false,
          kind: Default::default(),
        },
        type_only: false,
        asserts: None,
      })));
    }

    for item in module_items {
      match item {
        ModuleItem::ModuleDecl(decl) => {
          let item: ModuleItem = match decl {
            // match: import React, { useState } from "https://esm.sh/react"
            ModuleDecl::Import(import_decl) => {
              if import_decl.type_only {
                // ingore type import
                ModuleItem::ModuleDecl(ModuleDecl::Import(import_decl))
              } else {
                let mut resolver = self.resolver.borrow_mut();
                let (resolved_path, fixed_url) =
                  resolver.resolve(import_decl.src.value.as_ref(), false);
                if resolver.bundle_mode && resolver.bundle_externals.contains(fixed_url.as_str()) {
                  let mut names: Vec<(Ident, Option<String>)> = vec![];
                  let mut ns: Option<Ident> = None;
                  import_decl
                    .specifiers
                    .into_iter()
                    .for_each(|specifier| match specifier {
                      ImportSpecifier::Named(ImportNamedSpecifier {
                        local, imported, ..
                      }) => {
                        names.push((
                          local,
                          match imported {
                            Some(name) => Some(name.sym.as_ref().into()),
                            None => None,
                          },
                        ));
                      }
                      ImportSpecifier::Default(ImportDefaultSpecifier { local, .. }) => {
                        names.push((local, Some("default".into())));
                      }
                      ImportSpecifier::Namespace(ImportStarAsSpecifier { local, .. }) => {
                        ns = Some(local);
                      }
                    });
                  if let Some(name) = ns {
                    ModuleItem::Stmt(Stmt::Decl(Decl::Var(VarDecl {
                      span: DUMMY_SP,
                      kind: VarDeclKind::Const,
                      declare: false,
                      decls: vec![create_aleph_pack_var_decl(fixed_url.as_ref(), name)],
                    })))
                  } else if names.len() > 0 {
                    // const {default: React, useState} = __ALEPH.pack["https://esm.sh/react"];
                    ModuleItem::Stmt(Stmt::Decl(Decl::Var(VarDecl {
                      span: DUMMY_SP,
                      kind: VarDeclKind::Const,
                      declare: false,
                      decls: vec![create_aleph_pack_var_decl_member(fixed_url.as_ref(), names)],
                    })))
                  } else {
                    ModuleItem::Stmt(Stmt::Empty(EmptyStmt { span: DUMMY_SP }))
                  }
                } else {
                  ModuleItem::ModuleDecl(ModuleDecl::Import(ImportDecl {
                    src: new_str(resolved_path),
                    ..import_decl
                  }))
                }
              }
            }
            // match: export { default as React, useState } from "https://esm.sh/react"
            // match: export * as React from "https://esm.sh/react"
            ModuleDecl::ExportNamed(NamedExport {
              type_only,
              specifiers,
              src: Some(src),
              ..
            }) => {
              if type_only {
                // ingore type export
                ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(NamedExport {
                  span: DUMMY_SP,
                  specifiers,
                  src: Some(src),
                  type_only: true,
                  asserts: None,
                }))
              } else {
                let mut resolver = self.resolver.borrow_mut();
                let (resolved_path, fixed_url) = resolver.resolve(src.value.as_ref(), false);
                if resolver.bundle_mode && resolver.bundle_externals.contains(fixed_url.as_str()) {
                  let mut names: Vec<(Ident, Option<String>)> = vec![];
                  let mut ns: Option<Ident> = None;
                  specifiers
                    .into_iter()
                    .for_each(|specifier| match specifier {
                      ExportSpecifier::Named(ExportNamedSpecifier { orig, exported, .. }) => {
                        names.push((
                          orig,
                          match exported {
                            Some(name) => Some(name.sym.as_ref().into()),
                            None => None,
                          },
                        ));
                      }
                      ExportSpecifier::Default(ExportDefaultSpecifier { exported, .. }) => {
                        names.push((exported, Some("default".into())));
                      }
                      ExportSpecifier::Namespace(ExportNamespaceSpecifier { name, .. }) => {
                        ns = Some(name);
                      }
                    });
                  if let Some(name) = ns {
                    ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(ExportDecl {
                      span: DUMMY_SP,
                      decl: Decl::Var(VarDecl {
                        span: DUMMY_SP,
                        kind: VarDeclKind::Const,
                        declare: false,
                        decls: vec![create_aleph_pack_var_decl(fixed_url.as_ref(), name)],
                      }),
                    }))
                  } else if names.len() > 0 {
                    ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(ExportDecl {
                      span: DUMMY_SP,
                      decl: Decl::Var(VarDecl {
                        span: DUMMY_SP,
                        kind: VarDeclKind::Const,
                        declare: false,
                        decls: vec![create_aleph_pack_var_decl_member(fixed_url.as_ref(), names)],
                      }),
                    }))
                  } else {
                    ModuleItem::Stmt(Stmt::Empty(EmptyStmt { span: DUMMY_SP }))
                  }
                } else {
                  ModuleItem::ModuleDecl(ModuleDecl::ExportNamed(NamedExport {
                    span: DUMMY_SP,
                    specifiers,
                    src: Some(new_str(resolved_path)),
                    type_only: false,
                    asserts: None,
                  }))
                }
              }
            }
            // match: export * from "https://esm.sh/react"
            ModuleDecl::ExportAll(ExportAll { src, .. }) => {
              let mut resolver = self.resolver.borrow_mut();
              let (resolved_path, fixed_url) = resolver.resolve(src.value.as_ref(), false);
              if resolver.bundle_mode && resolver.bundle_externals.contains(fixed_url.as_str()) {
                resolver.star_exports.push(fixed_url.clone());
                ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(ExportDecl {
                  span: DUMMY_SP,
                  decl: Decl::Var(VarDecl {
                    span: DUMMY_SP,
                    kind: VarDeclKind::Const,
                    declare: false,
                    decls: vec![create_aleph_pack_var_decl(
                      fixed_url.as_ref(),
                      quote_ident!(format!("$$star_{}", resolver.star_exports.len() - 1)),
                    )],
                  }),
                }))
              } else {
                if self.is_dev {
                  ModuleItem::ModuleDecl(ModuleDecl::ExportAll(ExportAll {
                    span: DUMMY_SP,
                    src: new_str(resolved_path.into()),
                    asserts: None,
                  }))
                } else {
                  let mut src = "".to_owned();
                  src.push('[');
                  src.push_str(fixed_url.as_str());
                  src.push(']');
                  src.push(':');
                  src.push_str(resolved_path.as_str());
                  resolver.star_exports.push(fixed_url.clone());
                  ModuleItem::ModuleDecl(ModuleDecl::ExportAll(ExportAll {
                    span: DUMMY_SP,
                    src: new_str(src.into()),
                    asserts: None,
                  }))
                }
              }
            }
            // match: export ssr = {}
            ModuleDecl::ExportDecl(ExportDecl {
              decl: Decl::Var(var),
              ..
            }) => {
              let mut resolver = self.resolver.borrow_mut();
              let specifier = resolver.specifier.clone();
              let decl = var.decls.clone().into_iter().find(|decl| {
                if let Pat::Ident(ref binding) = decl.name {
                  specifier.starts_with("/pages/")
                    && (binding.id.sym.eq("ssrProps") || binding.id.sym.eq("ssgPaths"))
                } else {
                  false
                }
              });
              if let Some(d) = decl {
                if let Pat::Ident(ref binding) = d.name {
                  if binding.id.sym.eq("ssgPaths") {
                    resolver.ssg_paths_fn = Some(true);
                  } else if binding.id.sym.eq("ssrProps") {
                    let mut hasher = Sha1::new();
                    let fn_code = self.source.span_to_snippet(d.span.clone()).unwrap();
                    hasher.update(fn_code.clone());
                    let fn_hash = base64::encode(hasher.finalize());
                    resolver.ssr_props_fn = Some(fn_hash);
                  }
                }
              }
              ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(ExportDecl {
                span: DUMMY_SP,
                decl: Decl::Var(var),
              }))
            }
            _ => ModuleItem::ModuleDecl(decl),
          };
          items.push(item.fold_children_with(self));
        }
        _ => {
          items.push(item.fold_children_with(self));
        }
      };
    }

    items
  }

  // resolve `import.meta.url`
  fn fold_expr(&mut self, expr: Expr) -> Expr {
    let expr = match expr {
      Expr::Member(MemberExpr {
        span,
        obj,
        prop,
        computed,
      }) => {
        let mut is_import_meta_url_expr = false;
        if let Expr::Ident(id) = prop.as_ref() {
          if id.sym.as_ref().eq("url") {
            if let ExprOrSuper::Expr(ref expr) = obj {
              if let Expr::MetaProp(MetaPropExpr { meta, prop }) = expr.as_ref() {
                if meta.sym.as_ref().eq("import") && prop.sym.as_ref().eq("meta") {
                  is_import_meta_url_expr = true
                }
              }
            }
          }
        }
        if is_import_meta_url_expr {
          let resolver = self.resolver.borrow();
          let specifier = resolver.specifier.clone();
          if resolver.specifier_is_remote {
            Expr::Lit(Lit::Str(new_str(specifier)))
          } else {
            let path = Path::new(resolver.working_dir.as_str());
            let path = path.join(specifier.trim_start_matches("/"));
            Expr::Lit(Lit::Str(new_str(path.to_str().unwrap().into())))
          }
        } else {
          Expr::Member(MemberExpr {
            span,
            obj,
            prop,
            computed,
          })
        }
      }
      _ => expr,
    };

    expr.fold_children_with(self)
  }

  // resolve dynamic import url & sign useDeno hook
  // - `import("https://esm.sh/rect")` -> `import("/-/esm.sh/react.js")`
  // - `import("../components/logo.tsx")` -> `import("../components/logo.js#/components/logo.tsx@000000")`
  // - `import("../components/logo.tsx")` -> `__ALEPH.import("../components/logo.js#/components/logo.tsx@000000", "/pages/index.tsx")`
  // - `useDeno(() => {})` -> `useDeno(() => {}, null, "{KEY}")`
  fn fold_call_expr(&mut self, mut call: CallExpr) -> CallExpr {
    if is_call_expr_by_name(&call, "import") {
      let url = match call.args.first() {
        Some(ExprOrSpread { expr, .. }) => match expr.as_ref() {
          Expr::Lit(lit) => match lit {
            Lit::Str(s) => s.value.as_ref(),
            _ => return call,
          },
          _ => return call,
        },
        _ => return call,
      };
      let mut resolver = self.resolver.borrow_mut();
      if resolver.bundle_mode {
        call.callee = ExprOrSuper::Expr(Box::new(Expr::MetaProp(MetaPropExpr {
          meta: quote_ident!("__ALEPH"),
          prop: quote_ident!("import"),
        })))
      }
      let (resolved_path, fixed_url) = resolver.resolve(url, true);
      if resolver.bundle_mode {
        call.args = vec![ExprOrSpread {
          spread: None,
          expr: Box::new(Expr::Lit(Lit::Str(new_str(fixed_url)))),
        }];
      } else {
        call.args = vec![ExprOrSpread {
          spread: None,
          expr: Box::new(Expr::Lit(Lit::Str(new_str(resolved_path)))),
        }];
      }
    } else if is_call_expr_by_name(&call, "useDeno") {
      let callback_span = match call.args.first() {
        Some(ExprOrSpread { expr, .. }) => match expr.as_ref() {
          Expr::Fn(FnExpr {
            function: Function { span, .. },
            ..
          }) => Some(span),
          Expr::Arrow(ArrowExpr { span, .. }) => Some(span),
          Expr::Ident(Ident { span, .. }) => Some(span),
          _ => None,
        },
        _ => None,
      };
      if let Some(span) = callback_span {
        let id = self.new_use_deno_hook_ident(span);
        if call.args.len() == 1 {
          call.args.push(ExprOrSpread {
            spread: None,
            expr: Box::new(Expr::Lit(Lit::Null(Null { span: DUMMY_SP }))),
          });
        }
        if call.args.len() > 2 {
          call.args[2] = ExprOrSpread {
            spread: None,
            expr: Box::new(Expr::Lit(Lit::Str(new_str(id.clone())))),
          };
        } else {
          call.args.push(ExprOrSpread {
            spread: None,
            expr: Box::new(Expr::Lit(Lit::Str(new_str(id.clone())))),
          });
        }
        let mut resolver = self.resolver.borrow_mut();
        resolver.deno_hooks.push(id.into());
      }
    }

    call.fold_children_with(self)
  }
}

pub fn is_call_expr_by_name(call: &CallExpr, name: &str) -> bool {
  let callee = match &call.callee {
    ExprOrSuper::Super(_) => return false,
    ExprOrSuper::Expr(callee) => callee.as_ref(),
  };

  match callee {
    Expr::Ident(id) => id.sym.as_ref().eq(name),
    _ => false,
  }
}

fn create_aleph_pack_member_expr(url: &str) -> MemberExpr {
  MemberExpr {
    span: DUMMY_SP,
    obj: ExprOrSuper::Expr(Box::new(Expr::Ident(quote_ident!("__ALEPH")))),
    prop: Box::new(Expr::Member(MemberExpr {
      span: DUMMY_SP,
      obj: ExprOrSuper::Expr(Box::new(Expr::Ident(quote_ident!("pack")))),
      prop: Box::new(Expr::Lit(Lit::Str(Str {
        span: DUMMY_SP,
        value: url.into(),
        has_escape: false,
        kind: Default::default(),
      }))),
      computed: true,
    })),
    computed: false,
  }
}

fn create_aleph_pack_var_decl(url: &str, name: Ident) -> VarDeclarator {
  VarDeclarator {
    span: DUMMY_SP,
    name: Pat::Ident(BindingIdent {
      id: name,
      type_ann: None,
    }),
    init: Some(Box::new(Expr::Member(create_aleph_pack_member_expr(url)))),
    definite: false,
  }
}

pub fn create_aleph_pack_var_decl_member(
  url: &str,
  names: Vec<(Ident, Option<String>)>,
) -> VarDeclarator {
  VarDeclarator {
    span: DUMMY_SP,
    name: Pat::Object(ObjectPat {
      span: DUMMY_SP,
      props: names
        .into_iter()
        .map(|(name, rename)| {
          if let Some(rename) = rename {
            ObjectPatProp::KeyValue(KeyValuePatProp {
              key: PropName::Ident(quote_ident!(rename)),
              value: Box::new(Pat::Ident(BindingIdent {
                id: name,
                type_ann: None,
              })),
            })
          } else {
            ObjectPatProp::Assign(AssignPatProp {
              span: DUMMY_SP,
              key: name,
              value: None,
            })
          }
        })
        .collect(),
      optional: false,
      type_ann: None,
    }),
    init: Some(Box::new(Expr::Member(create_aleph_pack_member_expr(url)))),
    definite: false,
  }
}

fn new_str(str: String) -> Str {
  Str {
    span: DUMMY_SP,
    value: str.into(),
    has_escape: false,
    kind: Default::default(),
  }
}
