use crate::resolver::{is_remote_url, InlineStyle, Resolver};
use sha1::{Digest, Sha1};
use std::{cell::RefCell, rc::Rc};
use swc_common::{SourceMap, Spanned, DUMMY_SP};
use swc_ecma_ast::*;
use swc_ecma_utils::quote_ident;
use swc_ecma_visit::{noop_fold_type, Fold, FoldWith};

pub fn aleph_jsx_fold(
  resolver: Rc<RefCell<Resolver>>,
  source: Rc<SourceMap>,
  is_dev: bool,
) -> impl Fold {
  AlephJsxFold {
    resolver: resolver.clone(),
    source,
    inline_style_idx: 0,
    is_dev,
  }
}

/// aleph.js jsx fold, core functions include:
/// - add `__sourceFile` prop in development mode
/// - resolve `a` to `Anchor`
/// - resolve `head` to `Head`
/// - resolve `link` to `StyleLink`
/// - resolve `style` to `InlineStyle`
/// - resolve `script` to `CustomScript`
/// - optimize `img` in producation mode
struct AlephJsxFold {
  resolver: Rc<RefCell<Resolver>>,
  source: Rc<SourceMap>,
  inline_style_idx: i32,
  is_dev: bool,
}

impl AlephJsxFold {
  fn new_inline_style_ident(&mut self) -> String {
    let resolver = self.resolver.borrow();
    let mut ident: String = "inline-style-".to_owned();
    let mut hasher = Sha1::new();
    self.inline_style_idx = self.inline_style_idx + 1;
    hasher.update(resolver.specifier.clone());
    hasher.update(self.inline_style_idx.to_string());
    ident.push_str(
      base64::encode(hasher.finalize())
        .replace("+", "")
        .replace("/", "")
        .replace("=", "")
        .as_str(),
    );
    ident
  }

  fn fold_jsx_opening_element(
    &mut self,
    mut el: JSXOpeningElement,
  ) -> (JSXOpeningElement, Option<(String, String)>) {
    let mut inline_style: Option<(String, String)> = None;

    match &el.name {
      JSXElementName::Ident(id) => {
        let name = id.sym.as_ref();
        match name {
          "head" => {
            let mut resolver = self.resolver.borrow_mut();
            resolver.used_builtin_jsx_tags.insert("Head".into());
            el.name = JSXElementName::Ident(quote_ident!("__ALEPH_Head"));
          }

          "script" => {
            let mut resolver = self.resolver.borrow_mut();
            resolver.used_builtin_jsx_tags.insert("CustomScript".into());
            el.name = JSXElementName::Ident(quote_ident!("__ALEPH_CustomScript"));
          }

          "a" => {
            let mut resolver = self.resolver.borrow_mut();
            let mut should_replace = true;

            for attr in &el.attrs {
              match &attr {
                JSXAttrOrSpread::JSXAttr(JSXAttr {
                  name: JSXAttrName::Ident(id),
                  value: Some(JSXAttrValue::Lit(Lit::Str(Str { value, .. }))),
                  ..
                }) => {
                  let key = id.sym.as_ref();
                  let value = value.as_ref();
                  if (key == "href" && is_remote_url(value))
                    || (key == "target" && value == "_blank")
                  {
                    should_replace = false
                  }
                }
                _ => {}
              };
            }

            if should_replace {
              resolver.used_builtin_jsx_tags.insert("Anchor".into());
              el.name = JSXElementName::Ident(quote_ident!("__ALEPH_Anchor"));
            }
          }

          "link" => {
            let mut should_replace = false;

            for attr in &el.attrs {
              match &attr {
                JSXAttrOrSpread::JSXAttr(JSXAttr {
                  name: JSXAttrName::Ident(id),
                  value: Some(JSXAttrValue::Lit(Lit::Str(Str { value, .. }))),
                  ..
                }) => {
                  if id.sym.eq("rel") && (value.eq("stylesheet") || value.eq("style")) {
                    should_replace = true;
                    break;
                  }
                }
                _ => {}
              };
            }

            if should_replace {
              let mut href_prop_index: i32 = -1;
              let mut href_prop_value = "";

              for (i, attr) in el.attrs.iter().enumerate() {
                match &attr {
                  JSXAttrOrSpread::JSXAttr(JSXAttr {
                    name: JSXAttrName::Ident(id),
                    value: Some(JSXAttrValue::Lit(Lit::Str(Str { value, .. }))),
                    ..
                  }) => match id.sym.as_ref() {
                    "href" => {
                      href_prop_index = i as i32;
                      href_prop_value = value.as_ref();
                    }
                    _ => {}
                  },
                  _ => continue,
                };
              }

              let mut resolver = self.resolver.borrow_mut();
              let (resolved_path, fixed_url) = resolver.resolve(href_prop_value, false);
              resolver.add_extra_import(resolved_path.as_str());

              if href_prop_index >= 0 {
                el.attrs[href_prop_index as usize] = JSXAttrOrSpread::JSXAttr(JSXAttr {
                  span: DUMMY_SP,
                  name: JSXAttrName::Ident(quote_ident!("href")),
                  value: Some(JSXAttrValue::Lit(Lit::Str(Str {
                    span: DUMMY_SP,
                    value: fixed_url.into(),
                    has_escape: false,
                    kind: Default::default(),
                  }))),
                });
              }

              if name.eq("link") {
                resolver.used_builtin_jsx_tags.insert("StyleLink".into());
                el.name = JSXElementName::Ident(quote_ident!("__ALEPH_StyleLink"));
              }
            }
          }

          "style" => {
            let mut id_prop_index: i32 = -1;
            let mut type_prop_value = "css".to_owned();

            for (i, attr) in el.attrs.iter().enumerate() {
              match &attr {
                JSXAttrOrSpread::JSXAttr(JSXAttr {
                  name: JSXAttrName::Ident(id),
                  value: Some(JSXAttrValue::Lit(Lit::Str(Str { value, .. }))),
                  ..
                }) => match id.sym.as_ref() {
                  "__styleId" => {
                    id_prop_index = i as i32;
                  }
                  "type" => {
                    type_prop_value = value.as_ref().trim_start_matches("text/").to_string();
                  }
                  _ => {}
                },
                _ => continue,
              };
            }

            let id = self.new_inline_style_ident();
            let id_attr = JSXAttrOrSpread::JSXAttr(JSXAttr {
              span: DUMMY_SP,
              name: JSXAttrName::Ident(quote_ident!("__styleId")),
              value: Some(JSXAttrValue::Lit(Lit::Str(Str {
                span: DUMMY_SP,
                value: id.clone().into(),
                has_escape: false,
                kind: Default::default(),
              }))),
            });
            if id_prop_index >= 0 {
              el.attrs[id_prop_index as usize] = id_attr;
            } else {
              el.attrs.push(id_attr);
            }

            let mut resolver = self.resolver.borrow_mut();
            resolver.used_builtin_jsx_tags.insert("InlineStyle".into());
            el.name = JSXElementName::Ident(quote_ident!("__ALEPH_InlineStyle"));
            inline_style = Some((type_prop_value, id.into()));
          }

          "img" => {
            //todo: optimize img
          }

          _ => {}
        }
      }
      _ => {}
    };

    // copy from https://github.com/swc-project/swc/blob/master/ecmascript/transforms/src/react/jsx_src.rs
    if self.is_dev {
      let resolver = self.resolver.borrow_mut();
      match self.source.span_to_lines(el.span) {
        Ok(file_lines) => {
          el.attrs.push(JSXAttrOrSpread::JSXAttr(JSXAttr {
            span: DUMMY_SP,
            name: JSXAttrName::Ident(quote_ident!("__source")),
            value: Some(JSXAttrValue::JSXExprContainer(JSXExprContainer {
              span: DUMMY_SP,
              expr: JSXExpr::Expr(Box::new(
                ObjectLit {
                  span: DUMMY_SP,
                  props: vec![
                    PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                      key: PropName::Ident(quote_ident!("fileName")),
                      value: Box::new(Expr::Lit(Lit::Str(Str {
                        span: DUMMY_SP,
                        value: resolver.specifier.as_str().into(),
                        has_escape: false,
                        kind: Default::default(),
                      }))),
                    }))),
                    PropOrSpread::Prop(Box::new(Prop::KeyValue(KeyValueProp {
                      key: PropName::Ident(quote_ident!("lineNumber")),
                      value: Box::new(Expr::Lit(Lit::Num(Number {
                        span: DUMMY_SP,
                        value: (file_lines.lines[0].line_index + 1) as _,
                      }))),
                    }))),
                  ],
                }
                .into(),
              )),
            })),
          }));
        }
        _ => {}
      };
    }

    (el, inline_style)
  }
}

impl Fold for AlephJsxFold {
  noop_fold_type!();

  fn fold_jsx_element(&mut self, mut el: JSXElement) -> JSXElement {
    if el.span == DUMMY_SP {
      return el;
    }

    let mut children: Vec<JSXElementChild> = vec![];
    let (opening, inline_style) = self.fold_jsx_opening_element(el.opening);
    match inline_style {
      Some(ref inline_style) => {
        if el.children.len() == 1 {
          match el.children.first().unwrap() {
            JSXElementChild::JSXExprContainer(JSXExprContainer {
              expr: JSXExpr::Expr(expr),
              ..
            }) => match expr.as_ref() {
              Expr::Tpl(Tpl { exprs, quasis, .. }) => {
                let mut resolver = self.resolver.borrow_mut();
                let mut es: Vec<String> = vec![];
                let mut qs: Vec<String> = vec![];
                for expr in exprs {
                  let raw = self
                    .source
                    .span_to_snippet(expr.as_ref().span().clone())
                    .unwrap();
                  es.push(raw.into());
                }
                for quasi in quasis {
                  let raw = self.source.span_to_snippet(quasi.span.clone()).unwrap();
                  qs.push(raw.into());
                }
                let (t, id) = inline_style;
                resolver.inline_styles.insert(
                  id.into(),
                  InlineStyle {
                    r#type: t.into(),
                    exprs: es,
                    quasis: qs,
                  },
                );
                el.children = vec![JSXElementChild::JSXExprContainer(JSXExprContainer {
                  span: DUMMY_SP,
                  expr: JSXExpr::Expr(Box::new(Expr::Lit(Lit::Str(Str {
                    span: DUMMY_SP,
                    value: format!("%%{}-placeholder%%", id).into(),
                    has_escape: false,
                    kind: Default::default(),
                  })))),
                })];
              }
              _ => {}
            },
            _ => {}
          }
        }
      }
      _ => {}
    }
    for child in el.children {
      children.push(child.fold_children_with(self));
    }
    JSXElement {
      span: DUMMY_SP,
      opening,
      children,
      ..el
    }
  }
}

#[cfg(test)]
mod tests {
  use crate::swc::st;

  #[test]
  fn resolve_jsx_builtin_tags() {
    let source = r#"
      import React from "https://esm.sh/react"
      export default function Index() {
        return (
          <>
            <head>
              <title>Hello World!</title>
              <link rel="stylesheet" href="../style/index.css" />
            </head>
            <a href="/about">About</a>
            <a href="https://github.com">About</a>
            <a href="/about" target="_blank">About</a>
            <script src="ga.js"></script>
            <script>{`
              function gtag() {
                dataLayer.push(arguments)
              }
              window.dataLayer = window.dataLayer || [];
              gtag("js", new Date());
              gtag("config", "G-1234567890");
            `}</script>
          </>
        )
      }
    "#;
    let (code, resolver) = st("/pages/index.tsx", source, false);
    assert!(code.contains(
      "import __ALEPH_Anchor from \"../-/deno.land/x/aleph@v0.3.0/framework/react/components/Anchor.js\""
    ));
    assert!(code.contains(
      "import __ALEPH_Head from \"../-/deno.land/x/aleph@v0.3.0/framework/react/components/Head.js\""
    ));
    assert!(code.contains(
      "import __ALEPH_StyleLink from \"../-/deno.land/x/aleph@v0.3.0/framework/react/components/StyleLink.js\""
    ));
    assert!(code.contains(
      "import __ALEPH_CustomScript from \"../-/deno.land/x/aleph@v0.3.0/framework/react/components/CustomScript.js\""
    ));
    assert!(code.contains("React.createElement(\"a\","));
    assert!(code.contains("React.createElement(__ALEPH_Anchor,"));
    assert!(code.contains("React.createElement(__ALEPH_Head,"));
    assert!(code.contains("React.createElement(__ALEPH_StyleLink,"));
    assert!(code.contains("React.createElement(__ALEPH_CustomScript,"));
    assert!(code.contains("href: \"/style/index.css\""));
    assert!(code.contains(
      format!(
        "import   \"../style/index.css.js#{}@000000\"",
        "/style/index.css"
      )
      .as_str()
    ));
    let r = resolver.borrow_mut();
    assert_eq!(
      r.deps
        .iter()
        .map(|g| { g.specifier.as_str() })
        .collect::<Vec<&str>>(),
      vec![
        "/style/index.css",
        "https://deno.land/x/aleph@v0.3.0/framework/react/components/Head.ts",
        "https://deno.land/x/aleph@v0.3.0/framework/react/components/StyleLink.ts",
        "https://deno.land/x/aleph@v0.3.0/framework/react/components/Anchor.ts",
        "https://deno.land/x/aleph@v0.3.0/framework/react/components/CustomScript.ts",
        "https://esm.sh/react"
      ]
    );
  }

  #[test]
  fn resolve_inlie_style() {
    let source = r#"
      export default function Index() {
        const [color, setColor] = useState('white');

        return (
          <>
            <style>{`
              :root {
                --color: ${color};
              }
            `}</style>
            <style>{`
              h1 {
                font-size: 12px;
              }
            `}</style>
          </>
        )
      }
    "#;
    let (code, resolver) = st("/pages/index.tsx", source, false);
    assert!(code.contains(
      "import __ALEPH_InlineStyle from \"../-/deno.land/x/aleph@v0.3.0/framework/react/components/InlineStyle.js\""
    ));
    assert!(code.contains("React.createElement(__ALEPH_InlineStyle,"));
    assert!(code.contains("__styleId: \"inline-style-"));
    let r = resolver.borrow_mut();
    assert!(r.inline_styles.len() == 2);
  }
}
