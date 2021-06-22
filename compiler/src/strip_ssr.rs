use crate::resolve_fold::is_call_expr_by_name;
use swc_common::DUMMY_SP;
use swc_ecma_ast::*;
use swc_ecma_visit::{noop_fold_type, Fold, FoldWith};

pub fn strip_ssr_fold(specifier: &str) -> impl Fold {
  StripSSRFold {
    specifier: specifier.into(),
  }
}

pub struct StripSSRFold {
  specifier: String,
}

impl Fold for StripSSRFold {
  noop_fold_type!();

  fn fold_module_items(&mut self, module_items: Vec<ModuleItem>) -> Vec<ModuleItem> {
    let mut items = Vec::<ModuleItem>::new();

    for item in module_items {
      match item {
        ModuleItem::ModuleDecl(decl) => {
          let item: ModuleItem = match decl {
            // match: export ssr = {}
            ModuleDecl::ExportDecl(ExportDecl {
              decl: Decl::Var(var),
              ..
            }) => {
              let decls = var
                .decls
                .clone()
                .into_iter()
                .filter(|decl| {
                  if let Pat::Ident(ref binding) = decl.name {
                    !(self.specifier.starts_with("/pages/")
                      && (binding.id.sym.eq("ssrProps") || binding.id.sym.eq("ssgPaths")))
                  } else {
                    true
                  }
                })
                .collect::<Vec<VarDeclarator>>();
              if decls.is_empty() {
                ModuleItem::Stmt(Stmt::Empty(EmptyStmt { span: DUMMY_SP }))
              } else {
                ModuleItem::ModuleDecl(ModuleDecl::ExportDecl(ExportDecl {
                  span: DUMMY_SP,
                  decl: Decl::Var(VarDecl {
                    span: DUMMY_SP,
                    kind: var.kind,
                    declare: var.declare,
                    decls,
                  }),
                }))
              }
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

  // strip useDeno callback: `useDeno(() => {})` -> `useDeno(null, null, "{KEY}")`
  fn fold_call_expr(&mut self, mut call: CallExpr) -> CallExpr {
    if is_call_expr_by_name(&call, "useDeno") {
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
      if let Some(_) = callback_span {
        call.args[0] = ExprOrSpread {
          spread: None,
          expr: Box::new(Expr::Lit(Lit::Null(Null { span: DUMMY_SP }))),
        };
      }
    }

    call.fold_children_with(self)
  }
}
