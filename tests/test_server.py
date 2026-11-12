import unittest
import tempfile
from unittest.mock import patch

import server


class RedistributionTests(unittest.TestCase):
    def test_splits_demand_across_available_capacity(self):
        result = server.redistribute(50)

        self.assertEqual(result["requested"], 50)
        self.assertEqual(result["routed"], 50)
        self.assertEqual(result["unassigned"], 0)
        self.assertEqual(sum(route["vehicles"] for route in result["routes"]), 50)
        for route in result["routes"]:
            self.assertLessEqual(route["vehicles"], route["available_capacity"])
            self.assertLessEqual(
                route["vehicles"] + route["current_vehicles"], route["capacity"]
            )
        self.assertGreater(len(result["routes"]), 1)

    def test_reports_demand_above_total_network_capacity(self):
        result = server.redistribute(100)

        self.assertEqual(result["routed"], 52)
        self.assertEqual(result["unassigned"], 48)

    def test_rejects_invalid_demand(self):
        for value in (0, -1, 1.5, True, "50", 10_001):
            with self.subTest(value=value), self.assertRaises(server.InvalidDemand):
                server.redistribute(value)

    def test_network_contains_only_india_demo_coordinates(self):
        regions = server.REGIONS
        states = [region for region in regions if region["kind"] == "State"]
        union_territories = [
            region for region in regions if region["kind"] == "Union Territory"
        ]
        self.assertEqual(len(states), 28)
        self.assertEqual(len(union_territories), 8)
        self.assertEqual(len({region["id"] for region in regions}), 36)
        for region in regions:
            with self.subTest(region=region["name"]):
                self.assertGreaterEqual(region["lat"], 6)
                self.assertLessEqual(region["lat"], 38)
                self.assertGreaterEqual(region["lon"], 68)
                self.assertLessEqual(region["lon"], 98)

    def test_selected_region_moves_schematic_network_to_its_capital(self):
        region = next(region for region in server.REGIONS if region["id"] == "KA")

        network = server.get_network("KA")

        self.assertEqual(network["region"], "Karnataka")
        self.assertEqual(network["capital"], "Bengaluru")
        origin = next(node for node in network["nodes"] if node["id"] == "origin")
        self.assertEqual(origin["lat"], region["lat"])
        self.assertEqual(origin["lon"], region["lon"])

    def test_every_region_returns_capacity_bounded_recommendations(self):
        for region in server.REGIONS:
            with self.subTest(region=region["name"]):
                result = server.redistribute(50, region["id"])
                self.assertEqual(result["region"], region["name"])
                self.assertEqual(result["routed"], 50)
                for route in result["routes"]:
                    self.assertLessEqual(
                        route["vehicles"], route["available_capacity"]
                    )

    def test_rejects_unknown_region(self):
        with self.assertRaises(server.InvalidRegion):
            server.redistribute(50, "XX")

    def test_search_places_returns_only_india_results(self):
        response = [
            {"display_name": "Connaught Place, New Delhi, India", "lat": "28.6315", "lon": "77.2167"},
            {"display_name": "Outside India", "lat": "40.7128", "lon": "-74.0060"},
            {"display_name": "Invalid coordinates", "lat": "invalid", "lon": "77.0"},
        ]
        with patch.object(server, "_provider_json", return_value=response), patch.object(
            server.time, "sleep"
        ):
            places = server.search_places("Connaught Place")

        self.assertEqual(len(places), 1)
        self.assertEqual(places[0]["label"], "Connaught Place, New Delhi, India")

    def test_tomtom_suggestions_return_india_results_and_keep_key_server_side(self):
        response = {
            "results": [
                {
                    "position": {"lat": 22.5726, "lon": 88.3639},
                    "address": {"countryCode": "IN", "freeformAddress": "Kolkata, West Bengal"},
                    "poi": {"name": "Howrah Bridge"},
                },
                {
                    "position": {"lat": 22.0, "lon": 88.0},
                    "address": {"countryCode": "BD", "freeformAddress": "Outside India"},
                },
                {
                    "position": {"lat": 40.7, "lon": -74.0},
                    "address": {"countryCode": "US", "freeformAddress": "New York"},
                },
            ]
        }
        with patch.dict("os.environ", {"TOMTOM_API_KEY": "test-key"}), patch.object(
            server, "_provider_json", return_value=response
        ) as provider:
            places = server.suggest_places("Howrah Bridge")

        self.assertEqual(places, [{
            "label": "Howrah Bridge, Kolkata, West Bengal",
            "lat": 22.5726,
            "lon": 88.3639,
        }])
        request_url = provider.call_args.args[0]
        self.assertIn("typeahead=true", request_url)
        self.assertIn("countrySet=IN", request_url)
        self.assertIn("language=en-US", request_url)
        self.assertIn("key=test-key", request_url)
        self.assertNotIn("test-key", str(places))

    def test_tomtom_suggestions_require_a_key(self):
        with patch.dict("os.environ", {}, clear=True):
            with self.assertRaises(server.ProviderError):
                server.suggest_places("Kolkata")

    def test_nearby_places_filter_to_india_and_deduplicate(self):
        response = {
            "results": [
                {
                    "id": "place-1",
                    "position": {"lat": 22.57, "lon": 88.36},
                    "address": {"countryCode": "IN", "freeformAddress": "Kolkata"},
                    "poi": {"name": "City Cafe", "categories": ["cafe"]},
                },
                {
                    "id": "outside",
                    "position": {"lat": 22.57, "lon": 88.36},
                    "address": {"countryCode": "BD", "freeformAddress": "Outside India"},
                    "poi": {"name": "Wrong country"},
                },
            ]
        }
        with patch.dict("os.environ", {"TOMTOM_API_KEY": "test-key"}), patch.object(
            server, "_provider_json", side_effect=[response, response]
        ) as provider:
            places = server.nearby_places("food", 22.57, 88.36)

        self.assertEqual(len(places), 1)
        self.assertEqual(places[0]["label"], "City Cafe, Kolkata")
        self.assertEqual(places[0]["category"], "cafe")
        self.assertEqual(provider.call_count, 2)
        self.assertIn("categorySearch/restaurant.json", provider.call_args_list[0].args[0])
        self.assertIn("categorySearch/cafe.json", provider.call_args_list[1].args[0])

    def test_nearby_places_reject_invalid_category_and_radius(self):
        with patch.dict("os.environ", {"TOMTOM_API_KEY": "test-key"}):
            with self.assertRaises(server.InvalidLocation):
                server.nearby_places("unsupported", 22.57, 88.36)
            with self.assertRaises(server.InvalidLocation):
                server.nearby_places("food", 22.57, 88.36, 100)

    def test_reverse_geocode_returns_indian_address(self):
        response = {
            "addresses": [{
                "address": {
                    "countryCode": "IN",
                    "freeformAddress": "Park Street, Kolkata, West Bengal",
                }
            }]
        }
        with patch.dict("os.environ", {"TOMTOM_API_KEY": "test-key"}), patch.object(
            server, "_provider_json", return_value=response
        ) as provider:
            label = server.reverse_geocode(22.57, 88.36)

        self.assertEqual(label, "Park Street, Kolkata, West Bengal")
        self.assertIn("reverseGeocode/22.570000,88.360000.json", provider.call_args.args[0])

    def test_get_routes_formats_route_alternatives_and_instructions(self):
        response = {
            "code": "Ok",
            "routes": [
                {
                    "distance": 2400,
                    "duration": 180,
                    "geometry": {"coordinates": [[77.209, 28.614], [77.22, 28.63]]},
                    "legs": [{
                        "steps": [
                            {
                                "distance": 100,
                                "name": "",
                                "maneuver": {"type": "depart", "location": [77.209, 28.614]},
                            },
                            {
                                "distance": 2300,
                                "name": "Parliament Street",
                                "maneuver": {
                                    "type": "turn",
                                    "modifier": "right",
                                    "location": [77.22, 28.63],
                                },
                            },
                        ]
                    }],
                },
                {
                    "distance": 3100,
                    "duration": 240,
                    "geometry": {"coordinates": [[77.209, 28.614], [77.23, 28.64]]},
                    "legs": [],
                },
            ],
        }
        with patch.object(server, "_provider_json", return_value=response), patch.object(
            server, "_alternative_waypoints", return_value=[]
        ):
            result = server.get_routes(
                {"lat": 28.614, "lon": 77.209},
                {"lat": 28.63, "lon": 77.22},
            )

        self.assertEqual(len(result["routes"]), 2)
        self.assertEqual(result["routes"][0]["label"], "Fastest estimate")
        self.assertEqual(result["routes"][0]["duration_min"], 3)
        self.assertEqual(result["routes"][0]["points"][0], [28.614, 77.209])
        self.assertEqual(result["routes"][0]["instructions"][1]["text"], "Turn right onto Parliament Street")
        self.assertEqual(result["traffic"]["state"], "unavailable")

    def test_rejects_invalid_routing_coordinates(self):
        with self.assertRaises(server.InvalidLocation):
            server.get_routes(
                {"lat": 40.7, "lon": -74.0},
                {"lat": 28.63, "lon": 77.22},
            )

    def test_route_search_requests_distinct_paths_when_provider_has_fewer_than_three(self):
        def candidate(duration, geometry):
            return {
                "distance": 3000,
                "duration": duration,
                "geometry": {"coordinates": geometry},
                "legs": [],
            }

        responses = [
            {"code": "Ok", "routes": [candidate(300, [[77.20, 28.61], [77.21, 28.62]])]},
            {"code": "Ok", "routes": [candidate(
                330, [[77.20, 28.61], [77.21, 28.625], [77.21, 28.62]]
            )]},
            {"code": "Ok", "routes": [candidate(
                350, [[77.20, 28.61], [77.21, 28.615], [77.21, 28.62]]
            )]},
        ]
        with patch.object(server, "_provider_json", side_effect=responses) as provider:
            result = server.get_routes(
                {"lat": 28.61, "lon": 77.20},
                {"lat": 28.62, "lon": 77.21},
            )

        self.assertEqual(provider.call_count, 3)
        self.assertEqual(len(result["routes"]), 3)
        self.assertEqual(
            [route["label"] for route in result["routes"]],
            ["Fastest estimate", "Alternative 1", "Alternative 2"],
        )

    def test_tomtom_flow_segment_normalizes_and_caches_live_speed(self):
        response = {
            "flowSegmentData": {
                "currentSpeed": 18,
                "freeFlowSpeed": 45,
                "currentTravelTime": 120,
                "freeFlowTravelTime": 48,
                "confidence": 0.87,
                "roadClosure": False,
            }
        }
        with patch.dict("os.environ", {"TOMTOM_API_KEY": "test-key"}), patch.object(
            server, "_traffic_cache", {}
        ), patch.object(server, "_provider_json", return_value=response) as provider:
            first = server._tomtom_flow_segment(22.5726, 88.3639)
            second = server._tomtom_flow_segment(22.5726, 88.3639)

        self.assertEqual(provider.call_count, 1)
        self.assertEqual(first["current_speed_kmh"], 18)
        self.assertEqual(first["travel_time_ratio"], 2.5)
        self.assertEqual(second, first)

    def test_enrich_routes_marks_live_samples_and_adjusts_eta(self):
        sample = {
            "current_speed_kmh": 20,
            "free_flow_speed_kmh": 40,
            "confidence": 0.9,
            "road_closure": False,
            "travel_time_ratio": 2.0,
            "observed_at": "2026-11-08T10:00:00+00:00",
        }
        routes = [{
            "duration_min": 10,
            "points": [
                [22.57, 88.36],
                [22.58, 88.37],
                [22.59, 88.38],
                [22.60, 88.39],
                [22.61, 88.40],
                [22.62, 88.41],
            ],
        }]
        with patch.dict("os.environ", {"TOMTOM_API_KEY": "test-key"}), patch.object(
            server, "_tomtom_flow_segment", return_value=sample
        ):
            status = server.enrich_routes_with_traffic(routes)

        self.assertEqual(status["state"], "live")
        self.assertEqual(routes[0]["live_eta_min"], 20)
        self.assertEqual(routes[0]["traffic"]["sampled_segments"], 3)
        self.assertEqual(routes[0]["traffic"]["delay_percent"], 100)

    def test_refresh_existing_routes_preserves_ids_and_uses_live_samples(self):
        sample = {
            "current_speed_kmh": 20,
            "free_flow_speed_kmh": 40,
            "confidence": 0.9,
            "road_closure": False,
            "travel_time_ratio": 2.0,
            "observed_at": "2026-11-08T10:00:00+00:00",
        }
        request = {
            "routes": [{
                "id": "route-2",
                "duration_min": 10,
                "points": [
                    [22.57, 88.36], [22.58, 88.37], [22.59, 88.38],
                    [22.60, 88.39], [22.61, 88.40], [22.62, 88.41],
                ],
            }]
        }
        with patch.dict("os.environ", {"TOMTOM_API_KEY": "test-key"}), patch.object(
            server, "_traffic_cache", {}
        ), patch.object(server, "_tomtom_flow_segment", return_value=sample) as provider:
            result = server.sample_existing_routes(request["routes"])

        self.assertEqual(result["traffic"]["state"], "live")
        self.assertEqual(result["routes"][0]["id"], "route-2")
        self.assertEqual(result["routes"][0]["live_eta_min"], 20)
        self.assertEqual(provider.call_count, 3)

    def test_refresh_existing_routes_rejects_bad_coordinates_and_duplicate_ids(self):
        invalid_routes = [
            [{"id": "r1", "duration_min": 10, "points": [[40, 77], [28, 78]]}],
            [
                {"id": "r1", "duration_min": 10, "points": [[22, 77], [28, 78]]},
                {"id": "r1", "duration_min": 10, "points": [[22, 77], [28, 78]]},
            ],
        ]
        for routes in invalid_routes:
            with self.subTest(routes=routes), self.assertRaises(server.InvalidLocation):
                server.sample_existing_routes(routes)

    def test_traffic_status_never_returns_api_key(self):
        with patch.dict("os.environ", {"TOMTOM_API_KEY": "secret-test-value"}):
            status = server.get_traffic_status()

        self.assertTrue(status["configured"])
        self.assertNotIn("secret-test-value", str(status))

    def test_traffic_status_reports_missing_key_without_claiming_live_data(self):
        with patch.dict("os.environ", {}, clear=True):
            status = server.get_traffic_status()

        self.assertFalse(status["configured"])

    def test_startup_saves_key_encrypted_and_reuses_it_without_prompting(self):
        with tempfile.TemporaryDirectory() as local_app_data:
            with patch.dict(
                "os.environ", {"LOCALAPPDATA": local_app_data}, clear=True
            ), patch.object(server.sys.stdin, "isatty", return_value=True), patch.object(
                server.getpass, "getpass", return_value="replacement-key"
            ) as prompt, patch.object(
                server, "_dpapi_transform", side_effect=lambda data, decrypt: (
                    b"encrypted-value" if not decrypt else b"replacement-key"
                )
            ) as dpapi:
                configured = server.configure_tomtom_key()
                status_configured = server.get_traffic_status()["configured"]
                saved_file = server._tomtom_key_path()
                saved_contents = saved_file.read_bytes()
                server.os.environ.pop("TOMTOM_API_KEY")
                loaded = server.configure_tomtom_key()

        self.assertTrue(configured)
        self.assertTrue(status_configured)
        self.assertTrue(loaded)
        self.assertEqual(saved_contents, b"encrypted-value")
        self.assertNotIn(b"replacement-key", saved_contents)
        prompt.assert_called_once()
        self.assertEqual(dpapi.call_count, 2)

    def test_startup_does_not_prompt_in_noninteractive_terminal(self):
        with tempfile.TemporaryDirectory() as local_app_data, patch.dict(
            "os.environ", {"LOCALAPPDATA": local_app_data}, clear=True
        ), patch.object(
            server.sys.stdin, "isatty", return_value=False
        ), patch.object(server.getpass, "getpass") as prompt:
            configured = server.configure_tomtom_key()

        self.assertFalse(configured)
        prompt.assert_not_called()


if __name__ == "__main__":
    unittest.main()
