use swc_ecma_ast::*;
use swc_ecma_visit::{noop_fold_type, Fold};

pub struct ExportParser {
  pub names: Vec<String>,
}

impl ExportParser {
  fn push_pat(&mut self, pat: &Pat) {
    match pat {
      Pat::Ident(BindingIdent { id, .. }) => self.names.push(id.sym.as_ref().into()),
      Pat::Array(ArrayPat { elems, .. }) => elems.into_iter().for_each(|e| {
        if let Some(el) = e {
          self.push_pat(el)
        }
      }),
      Pat::Assign(AssignPat { left, .. }) => self.push_pat(left.as_ref()),
      Pat::Object(ObjectPat { props, .. }) => props.into_iter().for_each(|prop| match prop {
        ObjectPatProp::Assign(AssignPatProp { key, .. }) => {
          self.names.push(key.sym.as_ref().into())
        }
        ObjectPatProp::KeyValue(KeyValuePatProp { value, .. }) => self.push_pat(value.as_ref()),
        ObjectPatProp::Rest(RestPat { arg, .. }) => self.push_pat(arg.as_ref()),
      }),
      Pat::Rest(RestPat { arg, .. }) => self.push_pat(arg.as_ref()),
      _ => {}
    }
  }
}

impl Fold for ExportParser {
  noop_fold_type!();

  fn fold_module_items(&mut self, module_items: Vec<ModuleItem>) -> Vec<ModuleItem> {
    for item in &module_items {
      match item {
        ModuleItem::ModuleDecl(decl) => match decl {
          // match: export const foo = 'bar'
          // match: export function foo() {}
          // match: export class foo {}
          ModuleDecl::ExportDecl(ExportDecl { decl, .. }) => match decl {
            Decl::Class(ClassDecl { ident, .. }) => self.names.push(ident.sym.as_ref().into()),
            Decl::Fn(FnDecl { ident, .. }) => self.names.push(ident.sym.as_ref().into()),
            Decl::Var(VarDecl { decls, .. }) => decls.into_iter().for_each(|decl| {
              self.push_pat(&decl.name);
            }),
            _ => {}
          },
          // match: export default function
          // match: export default class
          ModuleDecl::ExportDefaultDecl(_) => self.names.push("default".into()),
          // match: export default foo
          ModuleDecl::ExportDefaultExpr(_) => self.names.push("default".into()),
          // match: export { default as React, useState } from "https://esm.sh/react"
          // match: export * as React from "https://esm.sh/react"
          ModuleDecl::ExportNamed(NamedExport {
            type_only,
            specifiers,
            ..
          }) => {
            if !type_only {
              specifiers
                .into_iter()
                .for_each(|specifier| match specifier {
                  ExportSpecifier::Named(ExportNamedSpecifier { orig, exported, .. }) => {
                    match exported {
                      Some(name) => self.names.push(name.sym.as_ref().into()),
                      None => self.names.push(orig.sym.as_ref().into()),
                    }
                  }
                  ExportSpecifier::Default(ExportDefaultSpecifier { exported, .. }) => {
                    self.names.push(exported.sym.as_ref().into());
                  }
                  ExportSpecifier::Namespace(ExportNamespaceSpecifier { name, .. }) => {
                    self.names.push(name.sym.as_ref().into())
                  }
                });
            }
          }
          // match: export * from "https://esm.sh/react"
          ModuleDecl::ExportAll(ExportAll { src, .. }) => {
            self.names.push(format!("{{{}}}", src.value))
          }
          _ => {}
        },
        _ => {}
      };
    }

    module_items
  }
}
