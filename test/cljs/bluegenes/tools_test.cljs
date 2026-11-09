(ns bluegenes.tools-test
  (:require [cljs.test :refer-macros [deftest is testing]]
            [bluegenes.pages.tools.events :as tools-events]))

(deftest official-tool?
  (testing "Only packages in the @intermine scope count as official"
    (is (tools-events/official-tool? "@intermine/bluegenes-protvista"))
    (is (not (tools-events/official-tool? "bluegenes-protvista")))
    (is (not (tools-events/official-tool? "@evil/intermine-tool")))
    (is (not (tools-events/official-tool? "intermine/@intermine/x")))
    (is (not (tools-events/official-tool? nil)))))
