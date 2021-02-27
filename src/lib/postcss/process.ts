import * as path from 'path'
import { ChildNode, Declaration, Helpers, Root } from 'postcss'
import valueParser, { FunctionNode, Node as ValueNode, WordNode } from 'postcss-value-parser'
import { isRelativeURI, normalizeRelativePath } from '../utils'
import {
  canSelectRootElement,
  isColorProperty,
  isColorValue,
  isTopRootDecl,
  isURLFunctionNode,
} from './assert'
import {
  makeVariableIdent,
  ThemePropertyMatcher,
  URLVarsDictItem,
  VariablesContainer,
  VarsDependencies,
  VarsDict,
  VarsDictItem,
} from './variables'
import {
  fixScssCustomizePropertyBug,
  getAllDependencies,
  getSourceFile,
  setVarsMessage,
} from './tools'

type DeclValueProcessor = ReturnType<typeof getDeclValueProcessor>
export interface CustomPropsDictItem extends VarsDictItem {
  rawNode: Declaration
  used?: boolean
}
export type CustomPropsDict = Map<string, CustomPropsDictItem>

interface DeclProcessorVarsContainer extends VariablesContainer {
  customProps: CustomPropsDict
}

type ProcessDeclValueWordOptions = {
  node: WordNode
  isRootDecl: boolean
  isVarFunction: boolean
  isDefault: boolean
  hasDefault: boolean
  onlyColor: boolean
  vars: DeclProcessorVarsContainer
  regExps: ThemePropertyMatcher
  helper: Helpers
  processor: DeclValueProcessor
}

type PropertyLike = {
  ident: string
  value: string
  originalValue: string
  dependencies?: VarsDependencies
  urlDependencies?: Map<string, string>
}

// 判定一个值节点是否是主题相关的变量
export function determineCanExtractToRootDeclByIdent(
  ident: string,
  onlyColor: boolean,
  context: VarsDict,
  variables: VarsDict
) {
  if (context.has(ident) || !variables.has(ident)) {
    // 当前文件包含这个变量声明，则认为是本地变量，不作主题变量处理
    // 如果不是本地变量，也不是全局变量，则是个无效的变量引用
    return false
  }
  const { value } = variables.get(ident)!
  // 需要对值进行解析判断
  return determineCanUseAsThemeVarsByValue(value, onlyColor)
}

// 根据变量的值来判定其是否能够被当成主题变量
export function determineCanUseAsThemeVarsByValue(value: string, onlyColor: boolean) {
  if (!value) {
    return false
  }
  if (onlyColor && !isColorValue(value)) {
    const parsed = valueParser(value)
    let hasColor = false
    // 可能是多值组合，比如：1px solid red
    // 对值进行解析处理，并逐一判定每个值
    parsed.walk((node) => {
      if (hasColor || node.type !== 'word' || (hasColor = isColorValue(node.value))) {
        // 返回false跳出迭代
        return false
      }
    }, true)

    if (!hasColor) {
      return false
    }
  }
  // 如果不仅仅是抽取颜色相关的变量值
  // 则所有的变量都当成主题变量对待
  return true
}

// 获取变量抽取迭代处理函数。
// 消息 theme-vars。
export function getDeclProcessor(options: {
  onlyColor: boolean
  syntax: string
  vars: DeclProcessorVarsContainer
  regExps: ThemePropertyMatcher
  helper: Helpers
}) {
  const { onlyColor, syntax, vars, regExps, helper } = options
  const { customProps } = vars
  const processor: DeclValueProcessor = getDeclValueProcessor(onlyColor, vars, regExps, helper)
  return (decl: Declaration) => {
    if (
      onlyColor &&
      !customProps.size &&
      !regExps[2].test(decl.prop) &&
      !isColorProperty(decl.prop)
    ) {
      return
    }
    decl.value = processor(decl.value, isTopRootDecl(decl), false, false, false)
    if (regExps[2].test(decl.prop)) {
      decl.value = fixScssCustomizePropertyBug(decl.value, syntax, regExps)
    }
  }
}

// 处理属性声明的值
function getDeclValueProcessor(
  onlyColor: boolean,
  vars: DeclProcessorVarsContainer,
  regExps: ThemePropertyMatcher,
  helper: Helpers
) {
  const processor = (
    value: string,
    isRootDecl: boolean,
    isVarFunction: boolean,
    isDefault: boolean,
    hasDefault: boolean
  ) => {
    if (!value) {
      return ''
    }
    let changed = false

    const iterator = (
      node: ValueNode,
      isVarFunction: boolean,
      isDefault: boolean,
      hasDefault: boolean
    ) => {
      if (node.type === 'function' && node.value === 'var') {
        valueParser.walk(node.nodes, (child, index, nodes) =>
          iterator(child, true, index > 0, nodes.length > 1)
        )
        return false
      } else if (node.type === 'word' && regExps[0].test(node.value)) {
        if (
          processDeclValueWord({
            node,
            isVarFunction,
            isDefault,
            hasDefault,
            isRootDecl,
            onlyColor,
            vars,
            helper,
            regExps,
            processor,
          })
        ) {
          changed = true
        }
      }
    }

    const parsed = valueParser(value)
    parsed.walk((node) => iterator(node, isVarFunction, isDefault, hasDefault))

    return changed ? valueParser.stringify(parsed.nodes) : value
  }
  //
  return processor
}

// 属性声明的值节点处理函数
// 消息 theme-prop-vars
function processDeclValueWord(options: ProcessDeclValueWordOptions) {
  const {
    node,
    isRootDecl,
    isVarFunction,
    isDefault,
    hasDefault,
    onlyColor,
    vars,
    regExps,
    helper,
    processor,
  } = options
  const { references, variables, context, customProps } = vars
  const varName = node.value
  const ident = makeVariableIdent(varName)
  const refVars = references.get(ident)
  let changed = false
  if (refVars) {
    changed = true
    // 递归处理引用值
    node.value = processor(refVars.originalValue, isRootDecl, isVarFunction, isDefault, hasDefault)
    //
  } else if (determineCanExtractToRootDeclByIdent(ident, onlyColor, context, variables)) {
    //
    const originalValue = node.value
    const varItem = variables.get(ident)!
    const value = varItem.value || originalValue
    const dependencies = varItem.dependencies
    setVarsMessage({
      ident,
      originalName: varName,
      originalValue,
      isRootDecl,
      value,
      helper,
      type: 'theme-prop-vars',
      parsed: true,
      dependencies,
      decl: undefined,
    })

    // 处理URL地址
    const processedValue = getProcessedPropertyValue(
      { ident, originalValue, value, dependencies },
      vars,
      regExps,
      helper
    )

    let defaultValue
    if (isVarFunction && regExps[2].test(processedValue)) {
      if (!isDefault) {
        defaultValue = value
      } else {
        defaultValue = processedValue
      }
    } else {
      defaultValue = processedValue
    }

    // 更新属性声明的值（修改原样式文件）
    if (isVarFunction) {
      if (hasDefault) {
        if (isDefault) {
          node.value = processedValue
        } else {
          node.value = ident
        }
      } else {
        node.value = `${ident}, ${defaultValue}`
      }
    } else {
      node.value = `var(${ident}, ${defaultValue})`
    }

    changed = true
  } else {
    // 不能作为主题变量抽取，检查是不是自定义属性
    if (isVarFunction && customProps.has(ident)) {
      // 标记是一个已经使用的自定义属性变量
      customProps.get(ident)!.used = true
    }
  }
  return changed
}

// 修正属性声明中的外部资源引用地址
// 影响写入样式文件中的属性值
export function getProcessedPropertyValue(
  property: PropertyLike,
  vars: VariablesContainer,
  regExps: ThemePropertyMatcher,
  helper: Helpers
) {
  const { originalValue, ident } = property
  const sourceFile = getSourceFile(helper)
  if (!sourceFile) {
    return originalValue
  }

  const { urlVars, variables, context } = vars
  let { urlDependencies } = property
  if (!urlDependencies) {
    urlDependencies = property.urlDependencies = new Map<string, string>()
  }

  if (urlDependencies.has(sourceFile)) {
    return urlDependencies.get(sourceFile)!
  }

  const varDeps = getAllDependencies(ident, variables, context)
  const urlDeps = new Map<string, URLVarsDictItem>()
  for (const dep of varDeps) {
    if (urlVars.has(dep)) {
      urlDeps.set(dep, urlVars.get(dep)!)
    }
  }
  if (!urlDeps.size) {
    urlDependencies.set(sourceFile, originalValue)
    return originalValue
  }

  const processor = getURLValueProcessor({ sourceFile, urlDeps, regExps, helper, vars })
  const processedValue = processor(originalValue)
  urlDependencies.set(sourceFile, processedValue)

  return processedValue
}

// 获取URL值处理器
function getURLValueProcessor(options: {
  sourceFile: string
  urlDeps: Map<string, URLVarsDictItem>
  regExps: ThemePropertyMatcher
  helper: Helpers
  vars: VariablesContainer
}) {
  const { sourceFile, urlDeps, regExps, helper, vars } = options
  const { variables, context } = vars
  const basedir = path.dirname(sourceFile)
  return (originalValue: string) => {
    const parsed = valueParser(originalValue)
    let updated = false

    parsed.walk((node) => {
      if (isURLFunctionNode(node, true)) {
        // 是一个url或image-set函数调用
        for (const urlItem of urlDeps.values()) {
          if (updateURLFunctionValue(node, urlItem, basedir)) {
            updated = true
          }
        }
        return false
      } else if (node.type === 'word' && regExps[0].test(node.value)) {
        // 是一个变量引用
        const ident = makeVariableIdent(node.value)
        const varsItem = variables.get(ident) || context.get(ident)
        if (varsItem) {
          // 递归处理变量值
          const { originalValue } = varsItem
          const processedValue = getProcessedPropertyValue(varsItem, vars, regExps, helper)
          if (processedValue !== originalValue) {
            node.value = processedValue
            updated = true
          }
        }
      }
    })

    return updated ? valueParser.stringify(parsed.nodes) : originalValue
  }
}

// 更新url函数节点中的url值
function updateURLFunctionValue(node: FunctionNode, varsDict: URLVarsDictItem, basedir: string) {
  const { data, from } = varsDict
  const relativeUrls = new Set([...data].filter((url) => isRelativeURI(url)))
  if (!relativeUrls.size) {
    return false
  }
  const fromContext = path.dirname(from)
  let updated = false

  valueParser.walk(node.nodes, (child) => {
    const url = child.value
    // 这里有可能会出现匹配不到的情况，这是因为，对该变量的处理可能已经进行过了，再次进入处理是由其他变量引用当前变量导致的
    if (relativeUrls.has(url)) {
      // 转换路径到当前文件上下文
      const rewrittenUrl = normalizeRelativePath(
        path.relative(basedir, path.join(fromContext, url))
      )
      if (rewrittenUrl !== normalizeRelativePath(url)) {
        updated = true
        child.value = rewrittenUrl
      }
    }
  })

  return updated
}

// 获取主题作用域处理器
export function getThemeScopeProcessor(syntax: string, scope: string, themeAttrName: string) {
  const scopeAttr = `[${themeAttrName}=${JSON.stringify(scope)}]`

  return (root: Root, handleSpecialNode: (node: ChildNode) => void) => {
    const process = (node: ChildNode) => {
      if (node.type === 'rule') {
        const { selectors = [] } = node
        node.selectors = selectors.map((selector) =>
          canSelectRootElement(selector)
            ? selector.replace(/(?<=(?:\[[^\]]*])+|^)(?:html|\\?:root)/i, (s) => `${s}${scopeAttr}`)
            : (syntax === 'sass' ? String.raw`\:root` : ':root') + `${scopeAttr} ${selector}`
        )
      } else if (node.type === 'atrule') {
        // @media、@supports、@keyframes、@document、@font-face、@page
        const { name } = node
        if (name === 'media' || name === 'supports' || name === 'document') {
          // 递归处理子节点
          node.each(process)
        } else if (/-?keyframes$/i.test(name) || name === 'font-face' || name === 'page') {
          handleSpecialNode(node)
        }
      }
    }
    // 处理属性声明
    root.each(process)
  }
}
