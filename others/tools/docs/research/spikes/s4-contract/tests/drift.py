import sys
n=sys.argv[1]; s=open('../contract/openapi.yaml').read()
if n=='rename_cursor': s=s.replace('next_cursor','next_token')
if n=='new_variant':
    s=s.replace("- $ref: '#/components/schemas/ListValue'\n      discriminator","- $ref: '#/components/schemas/ListValue'\n        - $ref: '#/components/schemas/UrlValue'\n      discriminator")
    s=s.replace("          list: '#/components/schemas/ListValue'\n","          list: '#/components/schemas/ListValue'\n          url: '#/components/schemas/UrlValue'\n")
    s=s.replace('    QuoteLocation:\n','    UrlValue:\n      type: object\n      required: [value_type, value]\n      properties:\n        value_type: { const: url }\n        value: { type: string }\n    QuoteLocation:\n',1)
if n=='required_removed': s=s.replace('required: [id, type, label, status, origin, sensitivity, merged_into]','required: [id, type, label, status, origin, sensitivity]')
if n=='rename_param': s=s.replace('as_of_valid','as_of_effective')
assert s!=open('../contract/openapi.yaml').read()
open(f'../drift/{n}/openapi.yaml','w').write(s)
