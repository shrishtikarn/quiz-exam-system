#!/usr/bin/env python3
"""Checks the CloudFormation templates, including the limit of 10 AWS services."""
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
TEMPLATES = [ROOT / "infra" / "00-storage.yaml", ROOT / "infra" / "10-app.yaml"]
MAX_TEMPLATE_BYTES = 51_200
MAX_SERVICES = 10
PSEUDO = {"AWS::Region", "AWS::AccountId", "AWS::StackName", "AWS::StackId", "AWS::NoValue", "AWS::Partition", "AWS::URLSuffix"}

SERVICE_BY_PREFIX = {
    "AWS::EC2::VPC": "Amazon VPC",
    "AWS::EC2::InternetGateway": "Amazon VPC",
    "AWS::EC2::VPCGatewayAttachment": "Amazon VPC",
    "AWS::EC2::Subnet": "Amazon VPC",
    "AWS::EC2::RouteTable": "Amazon VPC",
    "AWS::EC2::Route": "Amazon VPC",
    "AWS::EC2::SubnetRouteTableAssociation": "Amazon VPC",
    "AWS::EC2::SecurityGroup": "Amazon VPC",
    "AWS::EC2::LaunchTemplate": "Amazon EC2",
    "AWS::AutoScaling": "Amazon EC2 Auto Scaling",
    "AWS::ElasticLoadBalancingV2": "Elastic Load Balancing",
    "AWS::RDS": "Amazon RDS",
    "AWS::S3": "Amazon S3",
    "AWS::SecretsManager": "AWS Secrets Manager",
    "AWS::CloudWatch": "Amazon CloudWatch",
    "AWS::Logs": "Amazon CloudWatch",
    "AWS::CloudFront": "Amazon CloudFront",
}
# Used without creating resources in the templates.
IMPLICIT_SERVICES = {"AWS CloudFormation", "AWS IAM (existing LabRole only)"}


class Loader(yaml.SafeLoader):
    pass


def construct_tag(loader, suffix, node):
    if isinstance(node, yaml.ScalarNode):
        value = loader.construct_scalar(node)
    elif isinstance(node, yaml.SequenceNode):
        value = loader.construct_sequence(node, deep=True)
    else:
        value = loader.construct_mapping(node, deep=True)
    return {suffix: value}


Loader.add_multi_constructor("!", construct_tag)


def walk(node):
    yield node
    if isinstance(node, dict):
        for value in node.values():
            yield from walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from walk(value)


def service_for(resource_type):
    for prefix, service in sorted(SERVICE_BY_PREFIX.items(), key=lambda item: -len(item[0])):
        if resource_type == prefix or resource_type.startswith(prefix + "::"):
            return service
    raise ValueError(f"No service mapping for {resource_type}")


def check_template(path, errors):
    raw = path.read_bytes()
    if len(raw) > MAX_TEMPLATE_BYTES:
        errors.append(f"{path.name}: {len(raw)} bytes exceeds the direct deploy limit")
    template = yaml.load(raw, Loader=Loader)
    resources = template["Resources"]
    parameters = template.get("Parameters", {})
    conditions = template.get("Conditions", {})
    known = set(resources) | set(parameters) | PSEUDO
    used_parameters = set()
    services = set()

    def reference(name, where):
        if name not in known:
            errors.append(f"{path.name}: {where} refers to unknown {name}")
        if name in parameters:
            used_parameters.add(name)

    for logical_id, resource in resources.items():
        conditional = "Condition" in resource
        if conditional and resource["Condition"] not in conditions:
            errors.append(f"{path.name}: {logical_id} uses unknown condition")
        if not conditional:
            services.add(service_for(resource["Type"]))
        depends = resource.get("DependsOn", [])
        for name in [depends] if isinstance(depends, str) else depends:
            if name not in resources:
                errors.append(f"{path.name}: {logical_id} depends on unknown {name}")

    for section_name in ("Resources", "Outputs", "Conditions"):
        for node in walk(template.get(section_name, {})):
            if not isinstance(node, dict):
                continue
            if "Ref" in node and isinstance(node["Ref"], str):
                reference(node["Ref"], section_name)
            if "GetAtt" in node:
                target = node["GetAtt"]
                name = target.split(".")[0] if isinstance(target, str) else target[0]
                reference(name, section_name)
            if "If" in node and node["If"][0] not in conditions:
                errors.append(f"{path.name}: unknown condition {node['If'][0]}")
            if "Sub" in node:
                value = node["Sub"]
                text, local = (value, {}) if isinstance(value, str) else (value[0], value[1])
                for match in re.findall(r"\$\{([^!}][^}]*)\}", text):
                    name = match.split(".")[0]
                    if name not in local:
                        reference(name if "::" not in match else match, section_name)

    for name in parameters:
        if name not in used_parameters:
            errors.append(f"{path.name}: parameter {name} is never used")
    return services


def main():
    errors = []
    services = set(IMPLICIT_SERVICES)
    for path in TEMPLATES:
        services |= check_template(path, errors)
    if len(services) > MAX_SERVICES or len(services) < 5:
        errors.append(f"Default deployment uses {len(services)} services; the allowed range is 5 to {MAX_SERVICES}")
    print(f"Default deployment uses {len(services)} AWS services:")
    for service in sorted(services):
        print(f"  - {service}")
    if errors:
        print("\n".join(f"ERROR: {error}" for error in errors), file=sys.stderr)
        return 1
    print("Templates passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
